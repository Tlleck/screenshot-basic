import {
    OrthographicCamera,
    Scene,
    WebGLRenderTarget,
    LinearFilter,
    NearestFilter,
    RGBAFormat,
    UnsignedByteType,
    CfxTexture,
    ShaderMaterial,
    PlaneBufferGeometry,
    Mesh,
    WebGLRenderer
} from '@citizenfx/three';

class ScreenshotRequest {
    encoding: 'jpg' | 'png' | 'webp';
    quality: number;
    headers: any;

    correlation: string;

    resultURL: string;

    targetURL: string;
    targetField: string;
}

// Compatibility fallback for older CEF builds without canvas.toBlob().
function dataURItoBlob(dataURI: string) {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);

    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }

    return new Blob([ab], {type: mimeString});
}

class ScreenshotUI {
    renderer: any;
    rtTexture: any;
    sceneRTT: any;
    cameraRTT: any;
    material: any;
    requestQueue: ScreenshotRequest[] = [];
    captureScheduled: boolean = false;
    captureWidth: number = 0;
    captureHeight: number = 0;
    readBuffer: Uint8Array;
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    imageData: ImageData;

    initialize() {
        window.addEventListener('message', event => {
            const request = event.data && event.data.request;

            if (!request) {
                return;
            }

            this.requestQueue.push(request);
            this.scheduleCapture();
        });

        window.addEventListener('resize', event => {
            this.resize();
        });

        const cameraRTT: any = new OrthographicCamera( window.innerWidth / -2, window.innerWidth / 2, window.innerHeight / 2, window.innerHeight / -2, -10000, 10000 );
        cameraRTT.position.z = 100;

        const sceneRTT: any = new Scene();

        const rtTexture = new WebGLRenderTarget( window.innerWidth, window.innerHeight, { minFilter: LinearFilter, magFilter: NearestFilter, format: RGBAFormat, type: UnsignedByteType } );
        const gameTexture: any = new CfxTexture( );
        gameTexture.needsUpdate = true;

        const material = new ShaderMaterial( {

            uniforms: { "tDiffuse": { value: gameTexture } },
            vertexShader: `
			varying vec2 vUv;

			void main() {
				vUv = vec2(uv.x, 1.0-uv.y); // fuck gl uv coords
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			}
`,
            fragmentShader: `
			varying vec2 vUv;
			uniform sampler2D tDiffuse;

			void main() {
				gl_FragColor = texture2D( tDiffuse, vUv );
			}
`

        } );

        this.material = material;

        const plane = new PlaneBufferGeometry( window.innerWidth, window.innerHeight );
        const quad: any = new Mesh( plane, material );
        quad.position.z = -100;
        sceneRTT.add( quad );

        const renderer = new WebGLRenderer();
        renderer.setPixelRatio( window.devicePixelRatio );
        renderer.setSize( window.innerWidth, window.innerHeight );
        renderer.autoClear = false;

        document.getElementById('app').appendChild(renderer.domElement);
        document.getElementById('app').style.display = 'none';

        this.renderer = renderer;
        this.rtTexture = rtTexture;
        this.sceneRTT = sceneRTT;
        this.cameraRTT = cameraRTT;
        this.captureWidth = window.innerWidth;
        this.captureHeight = window.innerHeight;
    }

    resize() {
        this.captureWidth = window.innerWidth;
        this.captureHeight = window.innerHeight;

        const cameraRTT: any = new OrthographicCamera( window.innerWidth / -2, window.innerWidth / 2, window.innerHeight / 2, window.innerHeight / -2, -10000, 10000 );
        cameraRTT.position.z = 100;

        this.cameraRTT = cameraRTT;

        const sceneRTT: any = new Scene();

        const plane = new PlaneBufferGeometry( window.innerWidth, window.innerHeight );
        const quad: any = new Mesh( plane, this.material );
        quad.position.z = -100;
        sceneRTT.add( quad );

        this.sceneRTT = sceneRTT;

        if (this.rtTexture && this.rtTexture.dispose) {
            this.rtTexture.dispose();
        }

        this.rtTexture = new WebGLRenderTarget( window.innerWidth, window.innerHeight, { minFilter: LinearFilter, magFilter: NearestFilter, format: RGBAFormat, type: UnsignedByteType } );

        this.readBuffer = null;
        this.imageData = null;

        this.renderer.setSize( window.innerWidth, window.innerHeight );
    }

    scheduleCapture() {
        // Keep the NUI idle when there is no screenshot request. The old
        // implementation rendered the game texture every animation frame,
        // which consumed GPU time even while the resource was unused.
        if (this.captureScheduled) {
            return;
        }

        this.captureScheduled = true;

        requestAnimationFrame(() => {
            this.captureScheduled = false;

            const request = this.requestQueue.shift();

            if (!request) {
                return;
            }

            this.renderer.clear();
            this.renderer.render(this.sceneRTT, this.cameraRTT, this.rtTexture, true);

            // Let the browser/GPU finish the render before the readback. A
            // readRenderTargetPixels immediately after render forces a hard
            // GPU/CPU synchronization and is the biggest source of the FPS
            // hitch during a screenshot request.
            requestAnimationFrame(() => {
                this.handleRequest(request, () => {
                    if (this.requestQueue.length > 0) {
                        this.scheduleCapture();
                    }
                });
            });
        });
    }

    animate() {
        // Kept as a compatibility shim for code that may call this method
        // directly. Captures are now scheduled only when requested.
        this.scheduleCapture();
    }

    getCanvasContext() {
        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.canvas.style.display = 'inline';
            this.canvasContext = this.canvas.getContext('2d');
        }

        if (this.canvas.width !== this.captureWidth || this.canvas.height !== this.captureHeight) {
            this.canvas.width = this.captureWidth;
            this.canvas.height = this.captureHeight;
            this.imageData = this.canvasContext.createImageData(this.captureWidth, this.captureHeight);
        }

        return this.canvasContext;
    }

    sendResult(request: ScreenshotRequest, text: string) {
        if (request.resultURL) {
            fetch(request.resultURL, {
                method: 'POST',
                mode: 'cors',
                body: JSON.stringify({
                    data: text,
                    id: request.correlation
                })
            });
        }
    }

    uploadBlob(request: ScreenshotRequest, blob: Blob) {
        const formData = new FormData();
        formData.append(request.targetField, blob, `screenshot.${request.encoding}`);

        fetch(request.targetURL, {
            method: 'POST',
            mode: 'cors',
            headers: request.headers,
            body: formData
        })
        .then(response => response.text())
        .then(text => this.sendResult(request, text));
    }

    sendDataURI(request: ScreenshotRequest, imageURL: string) {
        fetch(request.targetURL, {
            method: 'POST',
            mode: 'cors',
            headers: request.headers,
            body: JSON.stringify({
                data: imageURL,
                id: request.correlation
            })
        })
        .then(response => response.text())
        .then(text => this.sendResult(request, text));
    }

    encodeDataURI(request: ScreenshotRequest, type: string) {
        const imageURL = this.canvas.toDataURL(type, request.quality);

        if (request.targetField) {
            this.uploadBlob(request, dataURItoBlob(imageURL));
            return;
        }

        this.sendDataURI(request, imageURL);
    }

    processPixels(request: ScreenshotRequest, done?: () => void) {
        // Prepare the reusable canvas to compress the image.
        const cxt = this.getCanvasContext();

        // draw the image on the canvas
        this.imageData.data.set(this.readBuffer);
        cxt.putImageData(this.imageData, 0, 0);

        // encode the image
        let type = 'image/png';

        switch (request.encoding) {
            case 'jpg':
                type = 'image/jpeg';
                break;
            case 'png':
                type = 'image/png';
                break;
            case 'webp':
                type = 'image/webp';
                break;
        }

        if (!request.quality) {
            request.quality = 0.92;
        }

        // actual encoding. toBlob keeps image encoding off the synchronous
        // request path. Uploads can use the Blob directly; only the legacy
        // requestScreenshot API needs an additional asynchronous Data URI.
        const onBlob = (blob: Blob) => {
            if (!blob) {
                this.encodeDataURI(request, type);
                if (done) {
                    done();
                }
                return;
            }

            if (request.targetField) {
                this.uploadBlob(request, blob);
                if (done) {
                    done();
                }
                return;
            }

            const reader = new FileReader();
            reader.onload = () => {
                this.sendDataURI(request, <string>reader.result);
                if (done) {
                    done();
                }
            };
            reader.onerror = () => {
                if (done) {
                    done();
                }
            };
            reader.readAsDataURL(blob);
        };

        if (this.canvas.toBlob) {
            this.canvas.toBlob(onBlob, type, request.quality);
        } else {
            this.encodeDataURI(request, type);
            if (done) {
                done();
            }
        }
    }

    handleRequest(request: ScreenshotRequest, done?: () => void) {
        // read the screenshot
        const bufferSize = this.captureWidth * this.captureHeight * 4;

        if (!this.readBuffer || this.readBuffer.length !== bufferSize) {
            this.readBuffer = new Uint8Array(bufferSize);
        }

        const finish = (buffer?: Uint8Array) => {
            if (buffer && buffer !== this.readBuffer) {
                this.readBuffer = buffer;
            }

            this.processPixels(request, done);
        };

        // Newer Three.js versions expose a non-blocking readback. The
        // bundled @citizenfx/three is older, so the synchronous fallback is
        // retained for existing FiveM installations.
        if (typeof this.renderer.readRenderTargetPixelsAsync === 'function') {
            try {
                Promise.resolve(this.renderer.readRenderTargetPixelsAsync(
                    this.rtTexture,
                    0,
                    0,
                    this.captureWidth,
                    this.captureHeight,
                    this.readBuffer
                ))
                .then((buffer: Uint8Array) => finish(buffer))
                .catch(() => {
                    this.renderer.readRenderTargetPixels(this.rtTexture, 0, 0, this.captureWidth, this.captureHeight, this.readBuffer);
                    finish();
                });
                return;
            } catch (e) {
                // Fall through to the legacy synchronous implementation.
            }
        }

        this.renderer.readRenderTargetPixels(this.rtTexture, 0, 0, this.captureWidth, this.captureHeight, this.readBuffer);
        finish();
    }
}

const ui = new ScreenshotUI();
ui.initialize();
