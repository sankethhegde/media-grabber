// Dynamic parts of the test page: canvas-made blob:/data: images, a delayed
// injected image and a scroll-triggered lazy loader.

function paint(label, hue) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 640, 360);
  grad.addColorStop(0, `hsl(${hue} 70% 45%)`);
  grad.addColorStop(1, `hsl(${hue + 60} 70% 35%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 640, 360);
  // Noise so the PNG is comfortably above the 2 KB data: URL threshold.
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.15})`;
    ctx.fillRect(Math.random() * 640, Math.random() * 360, 3, 3);
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, 320, 190);
  return canvas;
}

paint('blob: image', 200).toBlob((blob) => {
  document.getElementById('blob-img').src = URL.createObjectURL(blob);
}, 'image/png');

document.getElementById('data-img').src = paint('data: image', 20).toDataURL('image/png');

setTimeout(() => {
  const img = document.createElement('img');
  img.alt = 'Injected after 3 seconds';
  img.src = 'img/injected.jpg';
  img.width = 350;
  document.getElementById('injected').append(img);
}, 3000);

// VID-4: a video fed by MediaSource plays from a blob: URL.
if (window.MediaSource) {
  document.getElementById('mse-video').src = URL.createObjectURL(new MediaSource());
}

// Simulated DRM: EME players receive "encrypted" events on the media element.
// (A real CDM is not involved; this only exercises the detection path.)
// Fired late enough for the extension's content script (document_idle) to see it.
setTimeout(() => document.getElementById('drm-video').dispatchEvent(new Event('encrypted')), 3000);

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
    observer.unobserve(img);
  }
});
document.querySelectorAll('img.js-lazy').forEach((img) => observer.observe(img));
