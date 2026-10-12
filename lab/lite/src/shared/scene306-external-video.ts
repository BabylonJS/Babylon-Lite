export interface ExternalVideoFixture {
    readonly video: HTMLVideoElement;
    dispose(): void;
}

function waitForCurrentData(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= video.HAVE_CURRENT_DATA) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => finish(new Error("Timed out waiting for the generated video frame.")), 5000);
        const finish = (error?: Error): void => {
            window.clearTimeout(timeout);
            video.removeEventListener("loadeddata", onLoaded);
            video.removeEventListener("error", onError);
            error ? reject(error) : resolve();
        };
        const onLoaded = (): void => finish();
        const onError = (): void => finish(new Error("The generated canvas video failed to load."));
        video.addEventListener("loadeddata", onLoaded, { once: true });
        video.addEventListener("error", onError, { once: true });
    });
}

export async function createScene306ExternalVideo(): Promise<ExternalVideoFixture> {
    const source = document.createElement("canvas");
    source.width = 256;
    source.height = 256;
    const context = source.getContext("2d");
    if (!context) {
        throw new Error("Scene 306 requires a 2D canvas context.");
    }

    context.fillStyle = "#101828";
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = "#e8590c";
    context.fillRect(16, 16, 104, 104);
    context.fillStyle = "#15aabf";
    context.fillRect(136, 16, 104, 104);
    context.fillStyle = "#845ef7";
    context.fillRect(16, 136, 104, 104);
    context.fillStyle = "#94d82d";
    context.fillRect(136, 136, 104, 104);
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(128, 128, 38, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#101828";
    context.fillRect(118, 72, 20, 112);
    context.fillRect(72, 118, 112, 20);

    const stream = source.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    if (!track) {
        throw new Error("Scene 306 could not create a canvas video track.");
    }
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    try {
        const playing = video.play();
        track.requestFrame();
        await playing;
        await waitForCurrentData(video);
    } catch (error) {
        track.stop();
        video.srcObject = null;
        throw error;
    }

    return {
        video,
        dispose(): void {
            video.pause();
            track.stop();
            video.srcObject = null;
        },
    };
}
