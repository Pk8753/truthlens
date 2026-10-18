import type { KeyFrame } from './types';

export async function extractKeyFrames(videoUrl: string): Promise<KeyFrame[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  Object.assign(video.style, {
    position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '180px',
    opacity: '0', pointerEvents: 'none'
  });
  document.body.appendChild(video);

  const waitFor = (eventName: 'loadedmetadata' | 'seeked', timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener('error', onError);
      if (err) reject(err); else resolve();
    };
    const onEvent = () => finish();
    const onError = () => finish(new Error('Decode error.'));
    const timer = window.setTimeout(() => finish(new Error('Timeout.')), timeoutMs);
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
  });

  try {
    const loaded = waitFor('loadedmetadata', 15000);
    video.src = videoUrl;
    video.load();
    await loaded;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) return [];

    const marks = [...new Set([0.08, 0.33, 0.58, 0.83].map(ratio =>
      Number(Math.max(0, Math.min(Math.max(duration - 0.05, 0), duration * ratio)).toFixed(2))
    ))];
    const frames: KeyFrame[] = [];
    for (const timestamp of marks) {
      try {
        const sought = waitFor('seeked', 7000);
        video.currentTime = timestamp;
        await sought;
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
        const width = Math.min(640, video.videoWidth);
        const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) continue;
        context.drawImage(video, 0, 0, width, height);
        frames.push({ timestamp, dataUrl: canvas.toDataURL('image/jpeg', 0.72) });
      } catch { }
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}
