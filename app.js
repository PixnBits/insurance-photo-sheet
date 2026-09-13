(function () {
  "use strict";

  var ACCEPT = ["image/jpeg", "image/png", "image/webp"];
  var ACCEPT_EXT = /\.(jpe?g|png|webp)$/i;
  var MAX_EDGE = 1600;
  var JPEG_QUALITY = 0.72;
  var LARGE_BYTES = 10 * 1024 * 1024;
  var TYPICAL_COMPRESSED = 280000;

  var photos = [];
  var busy = false;
  var sawTool = false;
  var deskAnswered = false;

  var els = {};

  /**
   * Privacy-safe analytics helper.
   *
   * Payload shape (names + small integers / short enums only).
   * Never includes images, data URLs, filenames, captions, address, or claim #:
   *
   *   track('page_view')
   *   track('add_photos', { count: 3, total: 8 })
   *   track('edit_caption', { total: 8 })
   *   track('reorder', { total: 8 })
   *   track('download_click', { total: 8 })
   *   track('download_ok', { total: 8, pages: 9 })
   *   track('download_fail', { reason: 'jspdf' })
   *     reason ∈ 'empty' | 'jspdf' | 'size' | 'unknown'
   *   track('desk_accepted')
   *   track('desk_bounced')
   *   track('saw_tool')
   *
   * GoatCounter encoding (no user text in the path):
   *   event/add_photos/c3/t8
   *   event/download_ok/n8/p9
   *   event/download_fail/jspdf
   */
  function track(eventName, props) {
    props = props || {};
    if (eventName === "page_view") {
      return;
    }

    var parts = ["event", String(eventName)];
    if (typeof props.count === "number") {
      parts.push("c" + Math.round(props.count));
    }
    if (typeof props.total === "number") {
      parts.push(
        eventName === "download_ok"
          ? "n" + Math.round(props.total)
          : "t" + Math.round(props.total)
      );
    }
    if (typeof props.pages === "number") {
      parts.push("p" + Math.round(props.pages));
    }
    if (typeof props.reason === "string") {
      var allowed = { empty: 1, jspdf: 1, size: 1, unknown: 1 };
      parts.push(allowed[props.reason] ? props.reason : "unknown");
    }

    try {
      if (
        window.goatcounter &&
        typeof window.goatcounter.count === "function"
      ) {
        window.goatcounter.count({
          path: parts.join("/"),
          title: String(eventName),
          event: true,
        });
      }
    } catch (err) {
      /* tool still works if analytics is blocked */
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function localISODate(d) {
    d = d || new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function captionFromFilename(name) {
    var base = String(name || "").replace(/\.[^.]+$/, "");
    return base.replace(/_/g, " ");
  }

  function isAccepted(file) {
    if (ACCEPT.indexOf(file.type) !== -1) return true;
    if (!file.type && ACCEPT_EXT.test(file.name || "")) return true;
    return false;
  }

  function uid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function yieldToUi() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        setTimeout(resolve, 0);
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(reader.error || new Error("read"));
      };
      reader.readAsDataURL(blob);
    });
  }

  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("decode"));
      };
      img.src = url;
    });
  }

  async function decodeOriented(file) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (err) {
        try {
          return await createImageBitmap(file);
        } catch (err2) {
          /* fall through */
        }
      }
    }
    return decodeWithImg(file);
  }

  async function rasterToJpeg(source, maxEdge, quality) {
    var srcW = source.width;
    var srcH = source.height;
    var scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    var w = Math.max(1, Math.round(srcW * scale));
    var h = Math.max(1, Math.round(srcH * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    if (source.close) source.close();
    var blob = await new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (b) {
          if (b) resolve(b);
          else reject(new Error("toBlob"));
        },
        "image/jpeg",
        quality
      );
    });
    return { blob: blob, width: w, height: h };
  }

  async function makeThumb(file) {
    var bmp = await decodeOriented(file);
    var out = await rasterToJpeg(bmp, 160, 0.7);
    return URL.createObjectURL(out.blob);
  }

  async function prepareJpeg(file) {
    var bmp = await decodeOriented(file);
    var out = await rasterToJpeg(bmp, MAX_EDGE, JPEG_QUALITY);
    var dataUrl = await blobToDataUrl(out.blob);
    return {
      dataUrl: dataUrl,
      width: out.width,
      height: out.height,
      bytes: out.blob.size,
    };
  }

  function estimatePdfBytes() {
    var sum = 50000;
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      if (p.jpeg && p.jpeg.bytes) sum += p.jpeg.bytes;
      else sum += Math.min(p.file.size || TYPICAL_COMPRESSED, TYPICAL_COMPRESSED);
    }
    return sum;
  }

  function addressSlug(addr) {
    return String(addr || "")
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }

  function pdfFilename() {
    var date = (els.date && els.date.value) || localISODate();
    var slug = addressSlug(els.address && els.address.value);
    if (slug) return "photo-sheet-" + slug + "-" + date + ".pdf";
    return "photo-sheet-" + date + ".pdf";
  }

  function hasCover() {
    var address = (els.address.value || "").trim();
    var date = (els.date.value || "").trim();
    var claim = (els.claim.value || "").trim();
    return !!(address || date || claim);
  }

  function setStatus(text, isError) {
    els.status.textContent = text || "";
    els.status.classList.toggle("is-error", !!isError);
  }

  function updateCount() {
    var n = photos.length;
    els.count.textContent = n === 0 ? "None yet" : n === 1 ? "1 photo" : n + " photos";
    els.empty.hidden = n > 0;
    var large = n > 0 && estimatePdfBytes() >= LARGE_BYTES;
    els.warning.hidden = !large;
  }

  function iconBtn(label, path, extraClass) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn" + (extraClass ? " " + extraClass : "");
    btn.setAttribute("aria-label", label);
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    p.setAttribute("points", path);
    svg.appendChild(p);
    btn.appendChild(svg);
    return btn;
  }

  function rowEl(photo, index) {
    var li = document.createElement("li");
    li.className = "photo-row";
    li.dataset.id = photo.id;

    var thumb = document.createElement("div");
    thumb.className = "thumb-wrap";
    if (photo.thumbUrl) {
      var img = document.createElement("img");
      img.src = photo.thumbUrl;
      img.alt = "";
      thumb.appendChild(img);
    }
    li.appendChild(thumb);

    var field = document.createElement("div");
    field.className = "caption-field";
    var label = document.createElement("label");
    var inputId = "cap-" + photo.id;
    label.setAttribute("for", inputId);
    label.textContent = "Caption";
    var input = document.createElement("input");
    input.id = inputId;
    input.className = "caption-input";
    input.type = "text";
    input.value = photo.caption;
    input.dataset.photoId = photo.id;
    input.autocomplete = "off";
    input.addEventListener("input", function () {
      photo.caption = input.value;
      if (!photo.edited) {
        photo.edited = true;
        track("edit_caption", { total: photos.length });
      }
    });
    field.appendChild(label);
    field.appendChild(input);
    li.appendChild(field);

    var controls = document.createElement("div");
    controls.className = "row-controls";

    var up = iconBtn("Move up", "7 14 12 9 17 14");
    up.disabled = index === 0 || busy;
    up.addEventListener("click", function () {
      move(index, -1);
    });

    var down = iconBtn("Move down", "7 10 12 15 17 10");
    down.disabled = index === photos.length - 1 || busy;
    down.addEventListener("click", function () {
      move(index, 1);
    });

    var remove = iconBtn("Remove photo", "6 6 18 18", "danger");
    var remove2 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    remove2.setAttribute("points", "18 6 6 18");
    remove.querySelector("svg").appendChild(remove2);
    remove.disabled = busy;
    remove.addEventListener("click", function () {
      removePhoto(photo.id);
    });

    controls.appendChild(up);
    controls.appendChild(down);
    controls.appendChild(remove);
    li.appendChild(controls);
    return li;
  }

  function renderList() {
    var active = document.activeElement;
    var focusedId = active && active.dataset ? active.dataset.photoId : "";
    var start = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
    var end = active && typeof active.selectionEnd === "number" ? active.selectionEnd : null;

    els.list.replaceChildren();
    for (var i = 0; i < photos.length; i++) {
      els.list.appendChild(rowEl(photos[i], i));
    }
    updateCount();

    if (focusedId) {
      var el = els.list.querySelector('[data-photo-id="' + focusedId + '"]');
      if (el) {
        el.focus();
        if (start !== null) {
          try {
            el.setSelectionRange(start, end);
          } catch (err) {
            /* ignore */
          }
        }
      }
    }
  }

  function move(index, delta) {
    if (busy) return;
    var next = index + delta;
    if (next < 0 || next >= photos.length) return;
    var tmp = photos[index];
    photos[index] = photos[next];
    photos[next] = tmp;
    renderList();
    track("reorder", { total: photos.length });
  }

  function removePhoto(id) {
    if (busy) return;
    var idx = -1;
    for (var i = 0; i < photos.length; i++) {
      if (photos[i].id === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    var photo = photos[idx];
    if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);
    photos.splice(idx, 1);
    renderList();
  }

  async function addFiles(fileList) {
    if (busy) return;
    var incoming = Array.prototype.slice.call(fileList || []);
    var kept = [];
    var skipped = 0;
    for (var i = 0; i < incoming.length; i++) {
      if (isAccepted(incoming[i])) kept.push(incoming[i]);
      else skipped += 1;
    }

    if (skipped) {
      els.skip.hidden = false;
      els.skip.textContent =
        skipped === 1
          ? "Skipped 1 file that is not JPEG, PNG, or WebP (HEIC is not supported)."
          : "Skipped " +
            skipped +
            " files that are not JPEG, PNG, or WebP (HEIC is not supported).";
    } else {
      els.skip.hidden = true;
      els.skip.textContent = "";
    }

    if (!kept.length) return;

    var added = [];
    for (var j = 0; j < kept.length; j++) {
      var file = kept[j];
      added.push({
        id: uid(),
        file: file,
        caption: captionFromFilename(file.name),
        thumbUrl: "",
        edited: false,
        jpeg: null,
      });
    }
    photos = photos.concat(added);
    renderList();
    track("add_photos", { count: added.length, total: photos.length });

    for (var k = 0; k < added.length; k++) {
      try {
        added[k].thumbUrl = await makeThumb(added[k].file);
        var row = els.list.querySelector('[data-id="' + added[k].id + '"]');
        if (row) {
          var wrap = row.querySelector(".thumb-wrap");
          wrap.replaceChildren();
          var img = document.createElement("img");
          img.src = added[k].thumbUrl;
          img.alt = "";
          wrap.appendChild(img);
        }
      } catch (err) {
        /* thumbnail is optional */
      }
    }
  }

  function pdfSafeText(text) {
    return String(text || "")
      .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, "...")
      .replace(/\u00a0/g, " ");
  }

  function wrapText(doc, text, maxWidth) {
    var raw = pdfSafeText(text).trim();
    if (!raw) return [];
    return doc.splitTextToSize(raw, maxWidth);
  }

  function classifyFail(err) {
    if (!photos.length) return "empty";
    if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") return "jspdf";
    var msg = String((err && err.message) || err || "");
    if (/quota|memory|allocation|too large|maximum|out of memory/i.test(msg)) {
      return "size";
    }
    if (/jspdf|addImage|jsPDF/i.test(msg)) return "jspdf";
    return "unknown";
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  function formatCoverDate(iso) {
    if (!iso) return "";
    var parts = iso.split("-");
    if (parts.length !== 3) return iso;
    var dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(dt.getTime())) return iso;
    try {
      return dt.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (err) {
      return iso;
    }
  }

  async function buildPdf() {
    if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
      throw new Error("jspdf");
    }
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter" });
    var pageW = doc.internal.pageSize.getWidth();
    var pageH = doc.internal.pageSize.getHeight();
    var margin = 18;
    var captionBlock = 22;
    var cover = hasCover();
    var pages = (cover ? 1 : 0) + photos.length;
    var pageIndex = 0;

    if (cover) {
      pageIndex += 1;
      els.download.textContent = "Building PDF… " + pageIndex + " / " + pages;
      var y = 42;
      var address = pdfSafeText((els.address.value || "").trim());
      var date = (els.date.value || "").trim();
      var claim = pdfSafeText((els.claim.value || "").trim());
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(80);
      doc.text("Photo sheet", margin, 28);
      doc.setTextColor(20);
      doc.setFontSize(16);
      if (address) {
        var addrLines = doc.splitTextToSize(address, pageW - margin * 2);
        doc.text(addrLines, margin, y);
        y += addrLines.length * 8 + 8;
      }
      doc.setFontSize(12);
      if (date) {
        doc.text(formatCoverDate(date), margin, y);
        y += 10;
      }
      if (claim) {
        doc.text(claim, margin, y);
      }
      await yieldToUi();
    }

    for (var i = 0; i < photos.length; i++) {
      if (cover || i > 0) doc.addPage();
      pageIndex += 1;
      els.download.textContent = "Building PDF… " + pageIndex + " / " + pages;
      await yieldToUi();

      var photo = photos[i];
      var jpeg = photo.jpeg;
      if (!jpeg) {
        jpeg = await prepareJpeg(photo.file);
        photo.jpeg = jpeg;
      }

      var maxW = pageW - margin * 2;
      var maxH = pageH - margin * 2 - captionBlock;
      var ratio = Math.min(maxW / jpeg.width, maxH / jpeg.height);
      var drawW = jpeg.width * ratio;
      var drawH = jpeg.height * ratio;
      var x = (pageW - drawW) / 2;
      var yImg = margin;
      doc.addImage(
        jpeg.dataUrl,
        "JPEG",
        x,
        yImg,
        drawW,
        drawH,
        "ph" + i,
        "FAST"
      );

      var lines = wrapText(doc, photo.caption, maxW);
      if (lines.length) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
        doc.setTextColor(30);
        var textY = yImg + drawH + 8;
        var maxLines = 3;
        var shown = lines.slice(0, maxLines);
        doc.text(shown, pageW / 2, textY, { align: "center" });
      }
    }

    var blob = doc.output("blob");
    saveBlob(blob, pdfFilename());
    return { pages: pages, total: photos.length };
  }

  async function onDownload() {
    if (busy) return;
    if (!photos.length) {
      setStatus("Add photos first. This page will not make an empty PDF.", true);
      track("download_fail", { reason: "empty" });
      els.dropzone.focus();
      return;
    }

    track("download_click", { total: photos.length });
    busy = true;
    els.download.disabled = true;
    els.download.textContent = "Building PDF…";
    els.input.disabled = true;
    setStatus("Building PDF…", false);
    renderList();

    try {
      var result = await buildPdf();
      track("download_ok", { total: result.total, pages: result.pages });
      setStatus("PDF saved as " + pdfFilename() + ".", false);
      els.followup.hidden = false;
    } catch (err) {
      var reason = classifyFail(err);
      track("download_fail", { reason: reason });
      var msg =
        reason === "jspdf"
          ? "Could not load the PDF library. Check your connection and try again."
          : reason === "size"
            ? "This set is too large for the browser to finish. Split by elevation or floor and try a smaller batch."
            : "The PDF could not be built. Try fewer photos, or convert HEIC files to JPEG.";
      setStatus(msg, true);
    } finally {
      busy = false;
      els.download.disabled = false;
      els.download.textContent = "Download PDF";
      els.input.disabled = false;
      renderList();
    }
  }

  function onDesk(kind) {
    if (deskAnswered) return;
    deskAnswered = true;
    els.filed.disabled = true;
    els.bounced.disabled = true;
    if (kind === "accepted") {
      track("desk_accepted");
      els.thanks.hidden = false;
      els.thanks.textContent = "Noted. That is the signal that the ritual worked.";
    } else {
      track("desk_bounced");
      els.thanks.hidden = false;
      els.thanks.textContent = "";
      els.thanks.appendChild(
        document.createTextNode("Noted. Send the exact sentence they used — ")
      );
      var mail = document.createElement("a");
      mail.href = "mailto:?subject=desk%20bounce";
      mail.textContent = "desk bounce";
      els.thanks.appendChild(mail);
      els.thanks.appendChild(document.createTextNode(" — no photos."));
    }
  }

  function bindDrop(el) {
    el.addEventListener("click", function (e) {
      if (e.target === els.input) return;
      els.input.click();
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        els.input.click();
      }
    });
    el.addEventListener("dragenter", function (e) {
      e.preventDefault();
      el.classList.add("is-over");
    });
    el.addEventListener("dragover", function (e) {
      e.preventDefault();
      el.classList.add("is-over");
    });
    el.addEventListener("dragleave", function (e) {
      if (!el.contains(e.relatedTarget)) el.classList.remove("is-over");
    });
    el.addEventListener("drop", function (e) {
      e.preventDefault();
      el.classList.remove("is-over");
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
  }

  function boot() {
    els.address = $("cover-address");
    els.date = $("cover-date");
    els.claim = $("cover-claim");
    els.input = $("photo-input");
    els.dropzone = $("dropzone");
    els.list = $("photo-list");
    els.count = $("photo-count");
    els.empty = $("empty-hint");
    els.warning = $("size-warning");
    els.status = $("status");
    els.download = $("download-btn");
    els.skip = $("skip-note");
    els.followup = $("desk-followup");
    els.filed = $("desk-filed");
    els.bounced = $("desk-bounced");
    els.thanks = $("desk-thanks");

    els.date.value = localISODate();
    track("page_view");

    els.input.addEventListener("change", function () {
      addFiles(els.input.files);
      els.input.value = "";
    });
    bindDrop(els.dropzone);
    document.addEventListener("dragover", function (e) {
      e.preventDefault();
    });
    document.addEventListener("drop", function (e) {
      e.preventDefault();
    });

    els.download.addEventListener("click", onDownload);
    els.filed.addEventListener("click", function () {
      onDesk("accepted");
    });
    els.bounced.addEventListener("click", function () {
      onDesk("bounced");
    });

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting && !sawTool) {
              sawTool = true;
              track("saw_tool");
              io.disconnect();
            }
          }
        },
        { threshold: 0.25 }
      );
      io.observe($("tool"));
    }

    renderList();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
