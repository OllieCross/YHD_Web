/* YHD NYE — page behavior
   CSV tables, TOC, lightbox, toast, micro-interactions */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- welcome splash + fireworks ---------- */
  var welcome = document.getElementById("welcome");
  if (welcome) {
    var fwRaf = null;
    var dismissWelcome = function () {
      if (fwRaf) cancelAnimationFrame(fwRaf);
      welcome.classList.add("done");
      setTimeout(function () { welcome.remove(); }, 600);
    };
    if (reduceMotion) welcome.remove();
    else {
      welcome.addEventListener("click", dismissWelcome);
      setTimeout(dismissWelcome, 3000);

      /* subtle canvas fireworks behind the title */
      var cv = document.createElement("canvas");
      cv.className = "w-fireworks";
      welcome.insertBefore(cv, welcome.firstChild);
      var fctx = cv.getContext("2d");
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var setSize = function () {
        cv.width = welcome.clientWidth * dpr;
        cv.height = welcome.clientHeight * dpr;
      };
      setSize();

      var colors = ["#ffd873", "#529cca", "#52a37a", "#e0e0e0", "#ff9b8a", "#c7a6ff"];
      var particles = [];
      var burst = function (fx, fy) {
        var x = cv.width * fx, y = cv.height * fy;
        var color = colors[Math.floor(Math.random() * colors.length)];
        var n = 44 + Math.floor(Math.random() * 20);
        for (var i = 0; i < n; i++) {
          var ang = (Math.PI * 2 * i) / n + Math.random() * 0.15;
          var speed = (0.7 + Math.random() * 1.6) * dpr;
          particles.push({
            x: x, y: y,
            vx: Math.cos(ang) * speed,
            vy: Math.sin(ang) * speed,
            life: 120 + Math.random() * 60,
            max: 180,
            color: color,
            r: (1.1 + Math.random() * 0.8) * dpr,
          });
        }
      };
      [
        [0.25, 0.28, 150], [0.60, 0.35, 320], [0.75, 0.22, 550],
        [0.34, 0.44, 750], [0.50, 0.14, 950], [0.88, 0.16, 1150],
        [0.16, 0.42, 1350], [0.44, 0.20, 1500], [0.84, 0.38, 1650],
        [0.10, 0.18, 1850], [0.38, 0.24, 2050], [0.70, 0.44, 2200],
        [0.64, 0.30, 2400], [0.28, 0.16, 2550],
      ].forEach(function (b) {
        setTimeout(function () { burst(b[0], b[1]); }, b[2]);
      });

      var tick = function () {
        /* erase toward transparency slowly — leaves motion trails */
        fctx.globalCompositeOperation = "destination-out";
        fctx.fillStyle = "rgba(0, 0, 0, 0.10)";
        fctx.fillRect(0, 0, cv.width, cv.height);
        fctx.globalCompositeOperation = "source-over";
        for (var i = particles.length - 1; i >= 0; i--) {
          var p = particles[i];
          p.x += p.vx; p.y += p.vy;
          p.vy += 0.009 * dpr;   /* gentle gravity */
          p.vx *= 0.992; p.vy *= 0.992;
          p.life--;
          if (p.life <= 0) { particles.splice(i, 1); continue; }
          fctx.globalAlpha = Math.min(1, p.life / p.max) * 0.9;
          fctx.fillStyle = p.color;
          fctx.beginPath();
          fctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          fctx.fill();
        }
        fctx.globalAlpha = 1;
        fwRaf = requestAnimationFrame(tick);
      };
      fwRaf = requestAnimationFrame(tick);
    }
  }

  /* ---------- theme toggle ---------- */
  var themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var root = document.documentElement;
      var light = root.getAttribute("data-theme") === "light";
      if (light) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", "light");
      try { localStorage.setItem("yhd-theme", light ? "dark" : "light"); }
      catch { /* storage blocked - preference just won't persist */ }
    });
  }

  /* ---------- toast ---------- */
  var toastEl = document.getElementById("toast");
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  /* ---------- CSV parsing ---------- */
  function parseCSV(text) {
    var rows = [], row = [], field = "", inQ = false;
    text = text.replace(/^\uFEFF/, ""); // strip UTF-8 BOM
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) {
      return r.some(function (cell) { return cell.trim() !== ""; });
    });
  }

  function tagClass(v) {
    var t = v.toLowerCase();
    if (t.indexOf("frei") === 0) return "frei";
    if (t.indexOf("hsk") === 0) return "hsk";
    if (t.indexOf("service") === 0) return "service";
    if (t.indexOf("küche") === 0 || t.indexOf("kuche") === 0) return "kuche";
    if (t.indexOf("spa") === 0) return "spa";
    if (t.indexOf("bar") === 0) return "bar";
    return null;
  }

  /* ---------- table loading with skeleton + error states ---------- */
  function skeleton(cols, rows) {
    var box = document.createElement("div");
    box.className = "db-skeleton";
    for (var r = 0; r < rows; r++) {
      var line = document.createElement("div");
      line.className = "skel-row";
      for (var c = 0; c < cols; c++) {
        var cell = document.createElement("div");
        cell.className = "skel-cell";
        line.appendChild(cell);
      }
      box.appendChild(line);
    }
    return box;
  }

  function loadTable(tbl) {
    var scroll = tbl.parentElement; /* .db-scroll */
    var old = scroll.querySelector(".db-skeleton, .db-error");
    if (old) old.remove();
    tbl.innerHTML = "";
    tbl.style.display = "none";
    var skel = skeleton(6, 5);
    scroll.appendChild(skel);

    fetch(tbl.dataset.csv)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        var rows = parseCSV(text);
        if (!rows.length) throw new Error("empty");
        var useTags = tbl.dataset.tags === "1";
        var thead = document.createElement("thead");
        var headHtml = "<tr>";
        rows[0].forEach(function (h) { headHtml += "<th>" + escapeHtml(h) + "</th>"; });
        thead.innerHTML = headHtml + "</tr>";
        var tbody = document.createElement("tbody");
        rows.slice(1).forEach(function (r) {
          var tr = document.createElement("tr");
          r.forEach(function (cell, ci) {
            var td = document.createElement("td");
            var v = cell.trim();
            if (ci > 0 && (v === "Yes" || v === "No")) {
              td.innerHTML = '<span class="cb' + (v === "Yes" ? " on" : "") + '"></span>';
            } else if (useTags && ci > 0 && v) {
              td.innerHTML = v.split(",").map(function (part) {
                var p = part.trim();
                var cls = tagClass(p);
                return cls ? '<span class="tag ' + cls + '">' + escapeHtml(p) + "</span>" : escapeHtml(p);
              }).join(" ");
              if (td.querySelector(".tag")) td.classList.add("tags");
            } else td.textContent = v;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        tbl.appendChild(thead);
        tbl.appendChild(tbody);
        skel.remove();
        tbl.style.display = "";
        updateShadows(scroll);
      })
      .catch(function () {
        skel.remove();
        var err = document.createElement("div");
        err.className = "db-error";
        err.innerHTML = "<span>Tabuľku sa nepodarilo načítať.</span>";
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Skúsiť znova";
        btn.addEventListener("click", function () { loadTable(tbl); });
        err.appendChild(btn);
        scroll.appendChild(err);
        toast("Tabuľku sa nepodarilo načítať");
      });
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- table edge shadows ---------- */
  function updateShadows(scroll) {
    var wrap = scroll.parentElement;
    if (!wrap || !wrap.classList.contains("db-wrap")) return;
    var max = scroll.scrollWidth - scroll.clientWidth;
    wrap.classList.toggle("shadow-l", scroll.scrollLeft > 4);
    wrap.classList.toggle("shadow-r", max > 4 && scroll.scrollLeft < max - 4);
  }

  document.querySelectorAll(".db-scroll").forEach(function (scroll) {
    var wrap = document.createElement("div");
    wrap.className = "db-wrap";
    scroll.parentNode.insertBefore(wrap, scroll);
    wrap.appendChild(scroll);
    scroll.addEventListener("scroll", function () { updateShadows(scroll); }, { passive: true });
  });
  window.addEventListener("resize", function () {
    document.querySelectorAll(".db-scroll").forEach(updateShadows);
  });

  /* only CSV-driven tables need client-side loading;
     Notion-synced tables arrive pre-rendered */
  document.querySelectorAll("table.ndb[data-csv]").forEach(loadTable);

  /* ---------- image fade-in ---------- */
  document.querySelectorAll("figure.nimg img").forEach(function (img) {
    if (img.complete && img.naturalWidth > 0) img.classList.add("loaded");
    else {
      img.addEventListener("load", function () { img.classList.add("loaded"); });
      img.addEventListener("error", function () { img.classList.add("loaded"); });
    }
  });

  /* ---------- lightbox ---------- */
  var lb = document.getElementById("lightbox");
  var lbImg = lb ? lb.querySelector("img") : null;
  function closeLightbox() {
    if (lb) { lb.classList.remove("show"); }
  }
  document.addEventListener("click", function (e) {
    var img = e.target.closest ? e.target.closest("figure.nimg img") : null;
    if (img && lb) {
      lbImg.src = img.src;
      lb.classList.add("show");
    } else if (e.target === lb || e.target === lbImg) {
      closeLightbox();
    }
  });

  /* ---------- topbar scrolled state + reading progress ---------- */
  var topbar = document.querySelector(".topbar");
  var progress = document.getElementById("progress");
  var scrollTick = false;
  function onScroll() {
    if (topbar) topbar.classList.toggle("scrolled", window.scrollY > 8);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + "%";
    }
    markActive();
  }
  window.addEventListener("scroll", function () {
    if (!scrollTick) {
      scrollTick = true;
      requestAnimationFrame(function () { onScroll(); scrollTick = false; });
    }
  }, { passive: true });

  /* ---------- floating shortcuts (TOC) ---------- */
  var toc = document.getElementById("toc");
  var tocPanel = document.getElementById("toc-panel");
  var tocBtn = document.getElementById("toc-btn");
  var headings = Array.prototype.slice.call(document.querySelectorAll(".page > h2"));

  headings.forEach(function (h, i) {
    if (!h.id) h.id = "sec-" + i;
    var a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = h.textContent;
    a.addEventListener("click", function (e) {
      e.preventDefault();
      h.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", "#" + h.id);
      toc.classList.remove("open");
      /* re-align once layout settles (late-loading images can shift it) */
      var cancel = function () { clearTimeout(fix); cleanup(); };
      var cleanup = function () {
        window.removeEventListener("wheel", cancel);
        window.removeEventListener("touchstart", cancel);
      };
      var fix = setTimeout(function () {
        cleanup();
        h.scrollIntoView({ behavior: "auto", block: "start" });
      }, 650);
      window.addEventListener("wheel", cancel, { passive: true });
      window.addEventListener("touchstart", cancel, { passive: true });
    });
    tocPanel.appendChild(a);
  });

  if (tocBtn) {
    tocBtn.setAttribute("tabindex", "0");
    tocBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toc.classList.toggle("open");
      hideHint();
    });
    tocBtn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toc.classList.toggle("open");
      }
    });
  }
  document.addEventListener("click", function (e) {
    if (toc && !toc.contains(e.target)) toc.classList.remove("open");
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeLightbox();
      if (toc) toc.classList.remove("open");
    }
  });

  function markActive() {
    if (!tocPanel) return;
    var y = window.scrollY + 100;
    var current = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].offsetTop <= y) current = headings[i];
      else break;
    }
    var links = tocPanel.querySelectorAll("a");
    links.forEach(function (a) {
      a.classList.toggle("active", !!current && a.getAttribute("href") === "#" + current.id);
    });
  }
  markActive();

  /* ---------- onboarding hint (once) ---------- */
  var hint = document.getElementById("toc-hint");
  function hideHint() {
    if (hint) hint.classList.remove("show");
  }
  try {
    if (hint && !localStorage.getItem("yhd-toc-hint")) {
      setTimeout(function () { hint.classList.add("show"); }, 1200);
      setTimeout(hideHint, 6000);
      localStorage.setItem("yhd-toc-hint", "1");
    }
  } catch { /* storage blocked - skip hint */ }

  /* ---------- copy-to-clipboard (phone numbers) ---------- */
  document.querySelectorAll("[data-copy]").forEach(function (el) {
    el.classList.add("copyable");
    el.title = "Kopírovať";
    el.addEventListener("click", function () {
      var value = el.getAttribute("data-copy");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () {
          toast("Skopírované: " + value);
        }, function () { toast("Kopírovanie zlyhalo"); });
      } else toast("Kopírovanie nie je podporované");
    });
  });

  /* ---------- scroll reveal ---------- */
  if (!reduceMotion && "IntersectionObserver" in window) {
    var revealables = document.querySelectorAll(
      ".page > h2, .page > .bookmark, .page > figure, .page > .col-list, .page > details"
    );
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0.05 });
    revealables.forEach(function (el) {
      if (el.getBoundingClientRect().top > window.innerHeight) {
        el.classList.add("reveal");
        io.observe(el);
      }
    });
  }

  onScroll();
})();
