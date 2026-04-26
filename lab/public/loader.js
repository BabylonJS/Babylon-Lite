/**
 * Scene loader overlay — shows a spinner while WebGPU initializes.
 * Automatically fades out when canvas[data-ready="true"] is set.
 * Include via <script src="/loader.js"></script> before the scene script.
 */
(function () {
  var style = document.createElement('style');
  style.textContent = `
    #loader-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: #0d1117;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: opacity 0.4s ease;
    }
    #loader-overlay.fade-out { opacity: 0; pointer-events: none; }

    .loader-ring {
      width: 48px; height: 48px;
      border: 3px solid #21262d;
      border-top-color: #58a6ff;
      border-radius: 50%;
      animation: loader-spin 0.8s linear infinite;
    }
    @keyframes loader-spin { to { transform: rotate(360deg); } }

    .loader-text {
      margin-top: 1.25rem;
      color: #8b949e; font-size: 0.85rem; font-weight: 500;
      letter-spacing: 0.02em;
    }
    .loader-text span { color: #58a6ff; }

    .loader-error {
      margin-top: 1rem; padding: 0.75rem 1.25rem;
      background: #3d1117; border: 1px solid #f8514966;
      border-radius: 6px; color: #f85149;
      font-size: 0.8rem; max-width: 500px; text-align: center;
      display: none;
    }
  `;
  document.head.appendChild(style);

  var overlay = document.createElement('div');
  overlay.id = 'loader-overlay';
  overlay.innerHTML =
    '<div class="loader-ring"></div>' +
    '<div class="loader-text">Initializing Babylon <span>Lite</span></div>' +
    '<div class="loader-error"></div>';
  document.body.prepend(overlay);

  function dismiss() {
    overlay.classList.add('fade-out');
    overlay.addEventListener('transitionend', function () { overlay.remove(); });
  }

  function checkReady() {
    var canvas = document.getElementById('renderCanvas');
    // Dismiss as soon as the scene has rendered at least one frame (data-loaded),
    // OR the test-level ready signal is set (data-ready). data-loaded lets users
    // see physics/animation play out instead of being hidden until the test settles.
    if (canvas && (canvas.dataset.loaded === 'true' || canvas.dataset.ready === 'true')) {
      dismiss();
      return true;
    }
    return false;
  }

  // Watch for data-ready via MutationObserver + polling fallback
  var canvas = document.getElementById('renderCanvas');
  if (canvas) {
    var observer = new MutationObserver(function () {
      if (checkReady()) observer.disconnect();
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-ready', 'data-loaded'] });
  }
  var poll = setInterval(function () { if (checkReady()) clearInterval(poll); }, 200);

  // Show errors
  function showError(msg) {
    var box = overlay.querySelector('.loader-error');
    box.textContent = msg;
    box.style.display = 'block';
    overlay.querySelector('.loader-ring').style.borderTopColor = '#f85149';
    overlay.querySelector('.loader-text').innerHTML = '<span style="color:#f85149">Error</span>';
  }
  window.addEventListener('error', function (e) { showError(e.message || 'An error occurred'); });
  window.addEventListener('unhandledrejection', function (e) {
    showError(e.reason && e.reason.message || String(e.reason) || 'An error occurred');
  });
})();
