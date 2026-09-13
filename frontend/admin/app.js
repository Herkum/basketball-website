function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

// small helper so we can attach a listener inline while building nodes above
Element.prototype.also = function (fn) {
  fn(this);
  return this;
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(isoDateStr, days) {
  const d = new Date(`${isoDateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

// Basketball seasons span a calendar-year boundary (roughly Nov-Feb), so
// "this season" from July onward is year-(year+1); before that it's
// (year-1)-year. Used to auto-load the Schedule tab instead of leaving it
// on a blank "type a season and click Load" screen.
function defaultSeason() {
  const now = new Date();
  const year = now.getFullYear();
  return now.getMonth() >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

const overlayRoot = () => document.getElementById("ad-overlay-root");

/* ============================== Toast ============================== */

let toastTimer = null;
function showToast(text) {
  clearTimeout(toastTimer);
  let toastEl = document.getElementById("ad-toast");
  if (toastEl) toastEl.remove();
  toastEl = el("div", { class: "ad-toast", id: "ad-toast", text });
  overlayRoot().appendChild(toastEl);
  toastTimer = setTimeout(() => toastEl.remove(), 2600);
}

/* ============================ Confirm dialog ========================= */

function openConfirm({ noun, name, onConfirm }) {
  const backdrop = el("div", { class: "dialog-backdrop" });
  const dialog = el("div", { class: "dialog" }).also((d) => (d.style.width = "min(440px, 100%)"));
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const deleteBtn = el("button", { type: "button", class: "btn btn-secondary ad-del", text: "Delete" });
  const keepBtn = el("button", { type: "button", class: "btn btn-ghost", text: "Keep it" });

  deleteBtn.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting…";
    try {
      await onConfirm();
      backdrop.remove();
    } catch (err) {
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Delete";
    }
  });
  keepBtn.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", () => backdrop.remove());

  dialog.appendChild(el("h2", { class: "dialog-title", text: `Delete ${noun}?` }));
  dialog.appendChild(
    el("p", { style: "margin:10px 0 0;font-size:14px" }, [
      document.createTextNode(`"${name}" will be removed from the public site immediately. This cannot be undone.`),
    ])
  );
  dialog.appendChild(el("div", { class: "dialog-actions", style: "margin-top:22px" }, [deleteBtn, keepBtn]));
  backdrop.appendChild(dialog);
  overlayRoot().appendChild(backdrop);

  function onKey(e) {
    if (e.key === "Escape") {
      backdrop.remove();
      window.removeEventListener("keydown", onKey);
    }
  }
  window.addEventListener("keydown", onKey);
}

/* ========================= Image crop dialog ========================= */

// Crop viewport math: fit the image to a frame, let the user zoom/drag it
// behind a fixed crop window, then draw exactly the window's source
// rectangle onto an output canvas at a larger fixed resolution. Square
// (1:1) only, matching every real image field in this app (coach/team/
// player/logo photos are all cropped to a square avatar).
function openImageCropDialog(srcDataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const SW = 440,
        SH = 440;
      const state = { zoom: 1, ox: 0, oy: 0, nw: img.naturalWidth, nh: img.naturalHeight };
      const fit = Math.min(SW / state.nw, SH / state.nh);
      const cover = Math.max(SW / state.nw, SH / state.nh);
      const minZoom = Math.round((cover / fit) * 100) / 100;
      state.zoom = minZoom;

      const backdrop = el("div", { class: "dialog-backdrop" }).also((b) => (b.style.alignItems = "center"));
      const dialog = el("div", { class: "dialog" }).also((d) => (d.style.width = "min(520px, 100%)"));
      dialog.addEventListener("click", (e) => e.stopPropagation());

      const frame = el("div", { class: "ad-crop-frame" }).also((f) => {
        f.style.width = SW + "px";
        f.style.height = SH + "px";
      });
      const imgNode = el("img", { src: srcDataUrl, alt: "", draggable: "false" });
      const windowEl = el("div", { class: "ad-crop-window" });
      frame.appendChild(imgNode);
      frame.appendChild(windowEl);

      const zoomRange = el("input", { type: "range", min: "0.4", max: "6", step: "0.02" });
      const zoomLabel = el("span", { class: "ad-crop-zoom-label" });

      function geom() {
        const FW = SW * 0.82,
          FH = SH * 0.82;
        const fx = (SW - FW) / 2,
          fy = (SH - FH) / 2;
        const s = fit * state.zoom;
        const dw = state.nw * s,
          dh = state.nh * s;
        const maxX = Math.max(SW, dw) / 2,
          maxY = Math.max(SH, dh) / 2;
        state.ox = Math.min(maxX, Math.max(-maxX, state.ox));
        state.oy = Math.min(maxY, Math.max(-maxY, state.oy));
        return { FW, FH, fx, fy, s, dw, dh };
      }

      function render() {
        const g = geom();
        imgNode.style.width = g.dw + "px";
        imgNode.style.height = g.dh + "px";
        imgNode.style.left = SW / 2 + state.ox - g.dw / 2 + "px";
        imgNode.style.top = SH / 2 + state.oy - g.dh / 2 + "px";
        windowEl.style.left = g.fx + "px";
        windowEl.style.top = g.fy + "px";
        windowEl.style.width = g.FW + "px";
        windowEl.style.height = g.FH + "px";
        zoomRange.value = String(state.zoom);
        zoomLabel.textContent = state.zoom.toFixed(2) + "×";
      }
      render();

      frame.addEventListener("pointerdown", (startEvent) => {
        frame.setPointerCapture(startEvent.pointerId);
        const start = { x: startEvent.clientX, y: startEvent.clientY, ox: state.ox, oy: state.oy };
        function onMove(ev) {
          state.ox = start.ox + (ev.clientX - start.x);
          state.oy = start.oy + (ev.clientY - start.y);
          render();
        }
        function onUp(ev) {
          frame.releasePointerCapture(ev.pointerId);
          frame.removeEventListener("pointermove", onMove);
          frame.removeEventListener("pointerup", onUp);
        }
        frame.addEventListener("pointermove", onMove);
        frame.addEventListener("pointerup", onUp);
      });
      frame.addEventListener("wheel", (e) => {
        e.preventDefault();
        state.zoom = Math.min(6, Math.max(minZoom, state.zoom * (e.deltaY > 0 ? 0.94 : 1.06)));
        render();
      });
      zoomRange.addEventListener("input", () => {
        state.zoom = Number(zoomRange.value);
        render();
      });

      const useBtn = el("button", { type: "button", class: "btn btn-primary", text: "Use this crop" });
      const resetBtn = el("button", { type: "button", class: "btn btn-secondary", text: "Reset" });
      const cancelBtn = el("button", { type: "button", class: "btn btn-ghost", text: "Cancel" });

      resetBtn.addEventListener("click", () => {
        state.zoom = minZoom;
        state.ox = 0;
        state.oy = 0;
        render();
      });
      function close() {
        backdrop.remove();
        window.removeEventListener("keydown", onKey);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          close();
          reject(new Error("cancelled"));
        }
      }
      cancelBtn.addEventListener("click", () => {
        close();
        reject(new Error("cancelled"));
      });
      backdrop.addEventListener("click", () => {
        close();
        reject(new Error("cancelled"));
      });
      window.addEventListener("keydown", onKey);

      useBtn.addEventListener("click", () => {
        const g = geom();
        const OUT = 1200;
        const canvas = document.createElement("canvas");
        canvas.width = OUT;
        canvas.height = OUT;
        const ctx = canvas.getContext("2d");
        const left = SW / 2 + state.ox - g.dw / 2,
          top = SH / 2 + state.oy - g.dh / 2;
        const srcX = (g.fx - left) / g.s;
        const srcY = (g.fy - top) / g.s;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, OUT, OUT);
        ctx.drawImage(img, srcX, srcY, g.FW / g.s, g.FH / g.s, 0, 0, OUT, OUT);
        canvas.toBlob(
          (blob) => {
            close();
            resolve(blob);
          },
          "image/jpeg",
          0.9
        );
      });

      dialog.appendChild(el("h2", { class: "dialog-title", text: "Crop image" }));
      dialog.appendChild(
        el("p", { class: "ad-help", style: "margin:6px 0 0" }, [
          document.createTextNode(
            "The whole image is shown; the bright square window is what the site will use. Drag the image to reposition, scroll or slide to zoom in."
          ),
        ])
      );
      dialog.appendChild(el("div", { style: "margin:18px 0 0;display:flex;justify-content:center" }, [frame]));
      dialog.appendChild(el("div", { class: "ad-crop-zoom-row" }, [el("span", { class: "ad-tools-label", text: "Zoom" }), zoomRange, zoomLabel]));
      dialog.appendChild(el("div", { class: "dialog-actions" }, [useBtn, resetBtn, cancelBtn]));
      backdrop.appendChild(dialog);
      overlayRoot().appendChild(backdrop);
    };
    img.onerror = () => reject(new Error("Could not read that image"));
    img.src = srcDataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

/* ============================ Field builders ========================== */
// Each builder returns { wrap: <element>, getValue(): any, focusable?: element }
// `form` is the live in-progress values object for the modal; fields read
// sibling values from it (e.g. Schedule's Away-only fields) via visibleIf.

function fieldLabel(fd) {
  return el("label", { class: "ad-lbl", for: "f-" + fd.key }, [
    document.createTextNode(fd.label),
    fd.required ? el("span", { class: "ad-req", text: " *" }) : null,
  ].filter(Boolean));
}

function buildTextField(fd, value) {
  const input = el("input", {
    id: "f-" + fd.key,
    class: "ad-input",
    type: fd.type === "number" ? "number" : fd.type === "date" ? "date" : fd.type === "email" ? "email" : "text",
    placeholder: fd.placeholder || "",
  });
  input.value = value == null ? "" : value;
  if (fd.min != null) input.min = fd.min;
  if (fd.max != null) input.max = fd.max;
  return { input, getValue: () => input.value };
}

function buildTextareaField(fd, value, form) {
  const textarea = el("textarea", { id: "f-" + fd.key, class: "ad-input", rows: "6", placeholder: fd.placeholder || "" });
  textarea.value = value == null ? "" : value;
  const wrap = el("div", {});

  const showTabs = !!fd.html;
  if (!showTabs) {
    wrap.appendChild(textarea);
    return { wrap, getValue: () => textarea.value };
  }

  let mode = "write";
  const writeTab = el("button", { type: "button", class: "ad-sort", text: "HTML" });
  const previewTab = el("button", { type: "button", class: "ad-sort", text: "Preview" });
  const tabRow = el("div", { style: "display:flex;gap:14px;margin:-2px 0 8px;border-bottom:1px solid var(--color-divider)" }, [writeTab, previewTab]);
  const previewBox = el("div", {
    style:
      "border:1px solid var(--color-neutral-300);border-radius:var(--radius-sm);padding:16px 18px;min-height:150px;background:var(--color-bg);font-family:var(--font-body);line-height:1.6",
  });
  previewBox.hidden = true;
  const previewHelp = el("div", { class: "ad-help", text: "Rendered as it will appear on the page, in the site's type. Scripts are not run." });
  previewHelp.hidden = true;

  function paintTabs() {
    writeTab.style.borderBottom = "2px solid " + (mode === "write" ? "var(--color-accent)" : "transparent");
    writeTab.style.color = mode === "write" ? "var(--color-accent-700)" : "color-mix(in srgb, var(--color-text) 55%, transparent)";
    previewTab.style.borderBottom = "2px solid " + (mode === "preview" ? "var(--color-accent)" : "transparent");
    previewTab.style.color = mode === "preview" ? "var(--color-accent-700)" : "color-mix(in srgb, var(--color-text) 55%, transparent)";
    writeTab.style.padding = "6px 0";
    previewTab.style.padding = "6px 0";
    writeTab.style.fontFamily = "var(--font-heading)";
    previewTab.style.fontFamily = "var(--font-heading)";
    writeTab.style.fontSize = previewTab.style.fontSize = "12px";
    writeTab.style.textTransform = previewTab.style.textTransform = "uppercase";
    writeTab.style.letterSpacing = previewTab.style.letterSpacing = "0.08em";
    textarea.hidden = mode !== "write";
    previewBox.hidden = mode !== "preview";
    previewHelp.hidden = mode !== "preview";
    if (mode === "preview") {
      const stripped = textarea.value.replace(/<script[\s\S]*?<\/script>/gi, "");
      previewBox.innerHTML = stripped.trim() ? stripped : `<span style="color:color-mix(in srgb, var(--color-text) 45%, transparent)">Nothing to preview yet.</span>`;
    }
  }
  writeTab.addEventListener("click", () => {
    mode = "write";
    paintTabs();
  });
  previewTab.addEventListener("click", () => {
    mode = "preview";
    paintTabs();
  });
  // Only meaningful when the block isn't driven by a live-data generator -
  // a generator's public page ignores `body` entirely, so previewing it
  // would just be confusing.
  function updateTabsVisible() {
    const relevant = (form.generator || "None") === "None" || form.generator === "";
    tabRow.hidden = !relevant;
    if (!relevant) {
      mode = "write";
      paintTabs();
    }
  }
  paintTabs();
  updateTabsVisible();
  wrap.appendChild(tabRow);
  wrap.appendChild(textarea);
  wrap.appendChild(previewBox);
  wrap.appendChild(previewHelp);
  return { wrap, getValue: () => textarea.value, onFormChange: updateTabsVisible };
}

function buildSelectField(fd, value) {
  const options = fd.options || [];
  const select = el(
    "select",
    { id: "f-" + fd.key, class: "ad-input" },
    options.map((o) => el("option", { value: o.value != null ? o.value : o, text: o.label != null ? o.label : o || "None" }))
  );
  select.value = value == null || value === undefined ? (options[0]?.value ?? options[0] ?? "") : value;
  return { input: select, getValue: () => select.value };
}

function buildCheckboxField(fd, value) {
  const input = el("input", { type: "checkbox", id: "f-" + fd.key });
  input.checked = !!value;
  const row = el("label", { class: "ad-checkbox-row" }, [input, el("span", { text: fd.checkLabel || fd.label })]);
  return { wrap: row, getValue: () => input.checked, isCheckbox: true };
}

function buildMultiField(fd, value) {
  const selected = new Set(Array.isArray(value) ? value : []);
  const boxes = (fd.options || []).map((o) => {
    const val = o.value != null ? o.value : o;
    const label = o.label != null ? o.label : o;
    const input = el("input", { type: "checkbox" });
    input.checked = selected.has(val);
    input.dataset.val = val;
    return el("label", {}, [input, el("span", { text: label })]);
  });
  const wrap = el("div", { class: "ad-multi-row" }, boxes);
  return {
    wrap,
    getValue: () => boxes.filter((l) => l.querySelector("input").checked).map((l) => l.querySelector("input").dataset.val),
  };
}

// `raw: true` skips the crop dialog entirely (candid event photos at their
// natural aspect ratio, not avatar crops) - mirrors the old Photos-panel
// upload, which called uploadImageBlob() directly on the selected file.
function buildFileField(fd, value) {
  let currentUrl = value || "";
  const thumb = el("span", { class: "ad-file-thumb" }).also((t) => {
    t.style.width = "72px";
    t.style.height = "72px";
  });
  function paintThumb() {
    thumb.style.backgroundImage = currentUrl ? `url("${currentUrl}")` : "none";
  }
  paintThumb();

  const nameEl = el("span", { class: "ad-file-name" });
  const pickBtn = el("button", { type: "button", class: "btn btn-secondary", text: currentUrl ? "Replace image" : "Choose image" });
  const removeBtn = el("button", { type: "button", class: "btn btn-ghost", text: "Remove" });
  removeBtn.hidden = !currentUrl;
  const errorEl = el("p", { class: "ad-help", style: "color:#8c2f21" });
  errorEl.hidden = true;

  function paintName() {
    nameEl.textContent = currentUrl ? (fd.raw ? "Image uploaded" : "Cropped to square") : "No image chosen";
    pickBtn.textContent = currentUrl ? "Replace image" : "Choose image";
    removeBtn.hidden = !currentUrl;
  }
  paintName();

  async function handleFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      errorEl.textContent = "That file isn't an image";
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;
    pickBtn.disabled = true;
    pickBtn.textContent = "Uploading…";
    try {
      let blob = file;
      let contentType = file.type;
      if (!fd.raw) {
        const dataUrl = await readFileAsDataUrl(file);
        blob = await openImageCropDialog(dataUrl);
        contentType = "image/jpeg";
      }
      currentUrl = await uploadImageBlob(blob, contentType);
      paintThumb();
      paintName();
    } catch (err) {
      if (err.message !== "cancelled") {
        errorEl.textContent = `Upload failed: ${err.message}`;
        errorEl.hidden = false;
      }
    } finally {
      pickBtn.disabled = false;
      paintName();
    }
  }

  const fileInput = el("input", { type: "file", accept: "image/*", hidden: "" });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = "";
  });
  pickBtn.addEventListener("click", () => fileInput.click());
  removeBtn.addEventListener("click", () => {
    currentUrl = "";
    paintThumb();
    paintName();
  });

  const drop = el("div", { class: "ad-file-drop" }, [thumb, el("div", { style: "min-width:0" }, [nameEl, el("div", { class: "ad-file-buttons" }, [pickBtn, removeBtn])])]);
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  const wrap = el("div", {}, [
    drop,
    fileInput,
    el("div", { class: "ad-help" }, [
      document.createTextNode(fd.raw ? "Drop an image here or choose a file. JPEG or PNG, at its original aspect ratio." : "Drop an image here or choose a file — you'll crop it to square next. JPEG or PNG."),
    ]),
    errorEl,
  ]);

  return { wrap, getValue: () => currentUrl };
}

/* ============================= Modal form ============================= */

// meta.fields: [{ key,label,type,options,required,placeholder,span,help,
//   checkLabel,html,raw,visibleIf(form) }]
function openModal({ title, blurb, fields, initialValues, saveLabel, footnote, validate, onSave }) {
  const form = { ...initialValues };
  const backdrop = el("div", { class: "dialog-backdrop" });
  const dialog = el("div", { class: "dialog" });
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const bodyGrid = el("div", { class: "dialog-body" });
  const errorBox = el("div", { class: "dialog-error" });
  errorBox.hidden = true;

  const builders = [];
  function rebuildVisibility() {
    builders.forEach(({ fd, rowWrap }) => {
      rowWrap.hidden = fd.visibleIf ? !fd.visibleIf(form) : false;
    });
  }

  fields.forEach((fd) => {
    const value = form[fd.key];
    let built;
    if (fd.type === "textarea") built = buildTextareaField(fd, value, form);
    else if (fd.type === "select") built = buildSelectField(fd, value);
    else if (fd.type === "checkbox") built = buildCheckboxField(fd, value);
    else if (fd.type === "multi") built = buildMultiField(fd, value);
    else if (fd.type === "file") built = buildFileField(fd, value);
    else built = buildTextField(fd, value);

    form[fd.key] = built.getValue();

    const controlEl = built.wrap || built.input;
    if (built.input) {
      built.input.addEventListener("change", () => {
        form[fd.key] = built.getValue();
        rebuildVisibility();
        if (fd.onChange) fd.onChange(form);
      });
    } else if (fd.type === "multi") {
      controlEl.addEventListener("change", () => (form[fd.key] = built.getValue()));
    } else if (fd.type === "checkbox") {
      controlEl.querySelector("input").addEventListener("change", () => {
        form[fd.key] = built.getValue();
        rebuildVisibility();
        if (fd.onChange) fd.onChange(form);
      });
    }
    // Textarea's write/preview toggle needs to react to generator changes
    // made by a *different* field, not just its own.
    if (built.onFormChange) fields.forEach(() => {});

    const rowWrap = el("div", { class: fd.span === 2 ? "ad-field ad-field-span-2" : "ad-field" });
    if (fd.type !== "checkbox") rowWrap.appendChild(fieldLabel(fd));
    rowWrap.appendChild(controlEl);
    if (fd.help) rowWrap.appendChild(el("div", { class: "ad-help", text: fd.help }));
    bodyGrid.appendChild(rowWrap);
    builders.push({ fd, built, rowWrap, getValue: built.getValue });
  });

  // Re-run textarea preview-tab visibility whenever any field changes (it
  // depends on the sibling `generator` field, not just its own value).
  const generatorBuilder = builders.find((b) => b.built.onFormChange);
  if (generatorBuilder) {
    builders.forEach((b) => {
      if (b.built.input) b.built.input.addEventListener("change", generatorBuilder.built.onFormChange);
    });
  }

  rebuildVisibility();

  const saveBtn = el("button", { type: "button", class: "btn btn-primary", text: saveLabel });
  const cancelBtn = el("button", { type: "button", class: "btn btn-ghost", text: "Cancel" });

  function close() {
    backdrop.remove();
    window.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  window.addEventListener("keydown", onKey);

  saveBtn.addEventListener("click", async () => {
    errorBox.hidden = true;
    const values = {};
    builders.forEach(({ fd, getValue, rowWrap }) => {
      if (!rowWrap.hidden) values[fd.key] = getValue();
    });
    const requiredMissing = fields.filter((fd) => {
      if (!fd.required) return false;
      if (fd.visibleIf && !fd.visibleIf(form)) return false;
      const v = values[fd.key];
      return v === undefined || v === null || String(v).trim() === "";
    });
    if (requiredMissing.length) {
      errorBox.textContent = `${requiredMissing.map((f) => f.label).join(" and ")} ${requiredMissing.length > 1 ? "are" : "is"} required.`;
      errorBox.hidden = false;
      return;
    }
    if (validate) {
      const err = validate(values);
      if (err) {
        errorBox.textContent = err;
        errorBox.hidden = false;
        return;
      }
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await onSave(values);
      close();
    } catch (err) {
      errorBox.textContent = err.message || "Something went wrong.";
      errorBox.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = saveLabel;
    }
  });

  dialog.appendChild(
    el("div", { class: "dialog-head" }, [
      el("h2", { class: "dialog-title", text: title }),
      el("button", { type: "button", class: "btn btn-ghost", text: "Close" }).also((b) => b.addEventListener("click", close)),
    ])
  );
  if (blurb) dialog.appendChild(el("p", { class: "ad-help", style: "margin:6px 0 0", text: blurb }));
  dialog.appendChild(bodyGrid);
  dialog.appendChild(errorBox);
  dialog.appendChild(el("div", { class: "dialog-actions" }, [saveBtn, cancelBtn, el("span", { class: "ad-footnote", text: footnote || "Esc to cancel" })]));
  backdrop.appendChild(dialog);
  overlayRoot().appendChild(backdrop);
}

/* ============================= Option lists ============================ */

const PLAYER_YEARS = ["Freshman", "Sophomore", "Junior", "Senior"];
const CONTENT_BLOCK_GENERATORS = ["", "Coaches", "Rosters", "Schedule", "News", "Contact Us", "Sponsors", "Photos", "Standings", "Logo", "Mission Statement"];
const CONTACT_TYPES = ["Email", "Physical Address", "Instagram", "Phone"];
const CONTACT_KINDS = ["Program", "School", "Boosters", "Social"];
const SPONSOR_TIERS = ["Banner", "Court", "Friend of the Program"];

/* ========================== Generic list engine ========================= */
// `meta` shape:
// {
//   label, group, noun, newLabel, blurb, searchHint, emptyTitle, emptyBody,
//   idKey, listPath(), itemPath(item), createPath(),
//   reorder: bool,
//   columns: [{ label, key, sortable, render(item, ctx) => {kind,text,url} }],
//   fields: (ctx) => [...] | [...],
//   searchText(item) => string,
//   nameOf(item) => string (for delete confirm / toasts),
//   extraActions: (item, ctx) => [{label, onClick}],
//   onDeleted?, backLabel?, backAction?,
// }
async function renderGenericSection(container, meta, ctx = {}) {
  container.innerHTML = "";
  let query = "";
  let sort = null;
  let dragId = null;
  let items = [];

  const head = el("div", { class: "ad-section-head" });
  const headLeft = el("div", {});
  if (meta.backLabel) {
    headLeft.appendChild(
      el("button", { type: "button", class: "btn btn-ghost", text: meta.backLabel, style: "margin-bottom:10px" }).also((b) =>
        b.addEventListener("click", meta.backAction)
      )
    );
  }
  headLeft.appendChild(el("h1", { text: meta.label }));
  headLeft.appendChild(el("p", { class: "ad-section-blurb", text: meta.blurb || "" }));
  head.appendChild(headLeft);
  const newBtn = el("button", { type: "button", class: "btn btn-primary", text: meta.newLabel });
  head.appendChild(newBtn);
  container.appendChild(head);

  const toolbar = el("div", { class: "ad-toolbar" });
  const searchInput = el("input", { class: "ad-input ad-search", type: "search", placeholder: meta.searchHint || "Search" });
  const countLabel = el("span", { class: "ad-count" });
  const clearBtn = el("button", { type: "button", class: "btn btn-ghost", text: "Clear" });
  clearBtn.hidden = true;
  const resortHint = el("span", { class: "ad-hint", text: "Drag ☰ to reorder · click a row to edit" });
  toolbar.appendChild(searchInput);
  toolbar.appendChild(countLabel);
  toolbar.appendChild(clearBtn);
  toolbar.appendChild(resortHint);
  container.appendChild(toolbar);

  const tableWrap = el("div", { class: "ad-tbl-wrap" });
  container.appendChild(tableWrap);
  const emptyBox = el("div", { class: "ad-empty" });
  emptyBox.hidden = true;
  container.appendChild(emptyBox);

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    clearBtn.hidden = !query;
    paint();
  });
  clearBtn.addEventListener("click", () => {
    query = "";
    searchInput.value = "";
    clearBtn.hidden = true;
    paint();
  });

  function defaultSearchText(item) {
    return Object.entries(item)
      .filter(([k]) => k !== meta.idKey)
      .map(([, v]) => (Array.isArray(v) ? v.join(" ") : v))
      .join(" ")
      .toLowerCase();
  }

  async function persistOrder(list) {
    const updated = list.map((item, index) => ({ ...item, order: index }));
    await Promise.all(updated.map((item) => apiFetch(meta.itemPath(item), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) })));
  }

  function cellFor(col, item) {
    const out = col.render ? col.render(item, ctx) : { kind: "plain", text: item[col.key] == null ? "" : String(item[col.key]) };
    return out;
  }

  function paint() {
    const q = query.trim().toLowerCase();
    const search = meta.searchText || defaultSearchText;
    let rows = q ? items.filter((r) => search(r).includes(q)) : items.slice();

    if (sort) {
      const col = meta.columns.find((c) => c.key === sort.key);
      rows.sort((a, b) => {
        const av = cellFor(col, a).text || "",
          bv = cellFor(col, b).text || "";
        const na = parseFloat(String(av).replace(/[^0-9.\-]/g, "")),
          nb = parseFloat(String(bv).replace(/[^0-9.\-]/g, ""));
        const cmp = !isNaN(na) && !isNaN(nb) && String(av).trim() !== "" && String(bv).trim() !== "" ? na - nb : String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }

    countLabel.textContent = q ? `${rows.length} of ${items.length}` : `${items.length} ${items.length === 1 ? meta.noun : meta.noun + "s"}`;
    resortHint.textContent = sort ? "Sorted — drag reorder disabled while sorted" : meta.reorder ? "Drag ☰ to reorder · click a row to edit" : "Click a row to edit";

    tableWrap.innerHTML = "";
    emptyBox.hidden = rows.length !== 0;
    if (!rows.length) {
      emptyBox.innerHTML = "";
      emptyBox.appendChild(el("div", { class: "ad-empty-title", text: q ? "Nothing matches that" : meta.emptyTitle }));
      emptyBox.appendChild(el("p", { class: "ad-empty-body", text: q ? `No ${meta.noun}s contain "${query}".` : meta.emptyBody }));
      emptyBox.appendChild(
        el("button", { type: "button", class: "btn btn-primary", text: q ? "Clear search" : meta.newLabel }).also((b) =>
          b.addEventListener("click", () => {
            if (q) clearBtn.click();
            else newBtn.click();
          })
        )
      );
      return;
    }

    const canDrag = meta.reorder && !sort;
    const thead = el("thead", {}, [
      el("tr", {}, [
        el("th", { style: "width:26px" }),
        ...meta.columns.map((c) => {
          const active = sort && sort.key === c.key;
          const label = el("button", { type: "button", class: "ad-sort", text: c.label + (active ? (sort.dir === "asc" ? " ▲" : " ▼") : "") });
          label.addEventListener("click", () => {
            sort = active && sort.dir === "asc" ? { key: c.key, dir: "desc" } : { key: c.key, dir: "asc" };
            paint();
          });
          return el("th", { style: c.style || "" }, [label]);
        }),
        el("th", { style: "width:150px", text: "Actions" }),
      ]),
    ]);

    const tbody = el("tbody");
    rows.forEach((item) => {
      const tds = meta.columns.map((col) => {
        const cell = cellFor(col, item);
        const td = el("td", { class: col.kind === "num" ? "ad-num" : "" });
        if (cell.kind === "photo" && cell.url) {
          td.appendChild(el("span", { class: "ad-plate-thumb" }).also((s) => (s.style.backgroundImage = `url("${cell.url}")`)));
        } else if (cell.kind === "flag" && cell.text) {
          td.appendChild(el("span", { class: "tag tag-outline", text: cell.text }));
        } else if (cell.text) {
          td.appendChild(el("span", { style: cell.strong ? "font-family:var(--font-heading);font-size:17px" : "", text: cell.text }));
        } else {
          td.appendChild(el("span", { class: "ad-muted-cell", text: "—" }));
        }
        return td;
      });

      const actions = el("div", { class: "ad-actions" });
      (meta.extraActions ? meta.extraActions(item, ctx) : []).forEach((a) => {
        actions.appendChild(
          el("button", { type: "button", class: "btn btn-ghost", text: a.label }).also((b) =>
            b.addEventListener("click", (e) => {
              e.stopPropagation();
              a.onClick();
            })
          )
        );
      });
      actions.appendChild(
        el("button", { type: "button", class: "btn btn-secondary", text: "Edit" }).also((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            openEdit(item);
          })
        )
      );
      actions.appendChild(
        el("button", { type: "button", class: "btn btn-secondary ad-del", text: "Delete" }).also((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            openConfirm({
              noun: meta.noun,
              name: meta.nameOf ? meta.nameOf(item) : item[Object.keys(item)[0]] || meta.noun,
              onConfirm: async () => {
                await apiFetch(meta.itemPath(item), { method: "DELETE" });
                showToast(`${meta.noun[0].toUpperCase()}${meta.noun.slice(1)} deleted`);
                if (meta.onDeleted) meta.onDeleted(item);
                await refresh();
              },
            });
          })
        )
      );

      const row = el("tr", { draggable: canDrag ? "true" : "false" }, [el("td", { class: "ad-drag", text: canDrag ? "☰" : "" }), ...tds, el("td", {}, [actions])]);
      row.addEventListener("click", () => openEdit(item));

      if (canDrag) {
        row.addEventListener("dragstart", (e) => {
          dragId = item[meta.idKey];
          e.dataTransfer.effectAllowed = "move";
          row.classList.add("dragging");
        });
        row.addEventListener("dragend", () => row.classList.remove("dragging"));
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          row.classList.add("drag-over");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.classList.remove("drag-over");
          if (!dragId || dragId === item[meta.idKey]) return;
          const fromIndex = items.findIndex((i) => i[meta.idKey] === dragId);
          const toIndex = items.findIndex((i) => i[meta.idKey] === item[meta.idKey]);
          const [moved] = items.splice(fromIndex, 1);
          items.splice(toIndex, 0, moved);
          paint();
          persistOrder(items)
            .then(() => showToast("Order saved"))
            .catch(() => refresh());
        });
      }

      tbody.appendChild(row);
    });

    tableWrap.appendChild(el("table", { class: "ad-tbl" }, [thead, tbody]));
  }

  async function resolveFields() {
    return typeof meta.fields === "function" ? await meta.fields(ctx) : meta.fields;
  }

  function openEdit(item) {
    resolveFields().then((fields) =>
      openModal({
        title: `Edit ${meta.noun}`,
        blurb: meta.blurb,
        fields,
        initialValues: item,
        saveLabel: "Save changes",
        validate: meta.validate,
        onSave: async (values) => {
          await apiFetch(meta.itemPath(item), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...values, order: item.order }),
          });
          showToast("Changes saved");
          await refresh();
        },
      })
    );
  }

  newBtn.addEventListener("click", () => {
    resolveFields().then((fields) =>
      openModal({
        title: meta.newLabel,
        blurb: meta.blurb,
        fields,
        initialValues: meta.blankValues ? meta.blankValues(ctx) : {},
        saveLabel: `Create ${meta.noun}`,
        validate: meta.validate,
        onSave: async (values) => {
          await apiFetch(meta.createPath(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
          showToast(`${meta.noun[0].toUpperCase()}${meta.noun.slice(1)} created`);
          await refresh();
        },
      })
    );
  });

  async function refresh() {
    items = await apiFetch(meta.listPath());
    paint();
  }

  await refresh();
}

/* ============================== Sections ============================== */

function contentBlocksMeta() {
  return {
    label: "Content Blocks",
    group: "Content",
    noun: "block",
    newLabel: "New block",
    blurb: "Text and images the public pages pull in by name. A block with a generator renders live data instead of body text.",
    searchHint: "Search title or body",
    emptyTitle: "No blocks yet",
    emptyBody: "Blocks hold the copy the site shows — start with the header.",
    idKey: "block_id",
    reorder: true,
    listPath: () => "/content-blocks",
    itemPath: (item) => `/content-blocks/${encodeURIComponent(item.block_id)}`,
    createPath: () => "/content-blocks",
    nameOf: (item) => item.title,
    columns: [
      { label: "Photo", key: "image", style: "width:70px", render: (item) => ({ kind: "photo", url: item.image }) },
      { label: "Title", key: "title", render: (item) => ({ kind: "plain", strong: true, text: item.title || "" }) },
      { label: "Body", key: "body", render: (item) => ({ kind: "plain", text: (item.body || "").slice(0, 64) }) },
      { label: "Generator", key: "generator", style: "width:160px", render: (item) => ({ kind: "flag", text: item.generator || "" }) },
      { label: "NoIndex", key: "special", style: "width:90px", render: (item) => ({ kind: "plain", text: item.special ? "Yes" : "" }) },
    ],
    fields: [
      { key: "title", label: "Title", type: "text", required: true, placeholder: "Home", span: 1 },
      {
        key: "generator",
        label: "Generator",
        type: "select",
        span: 1,
        help: "Replaces the body with live data from that section.",
        options: CONTENT_BLOCK_GENERATORS.map((g) => ({ value: g, label: g || "None" })),
      },
      { key: "body", label: "Body", type: "textarea", span: 2, html: true, placeholder: "Shown on the page under the title. HTML is allowed." },
      { key: "image", label: "Photo", type: "file", span: 1 },
      { key: "special", label: "Search engines", type: "checkbox", checkLabel: "Hide this block from search engines (NoIndex)", span: 1 },
      {
        key: "league_name",
        label: "League Name",
        type: "text",
        placeholder: "Marmonte League",
        span: 1,
        visibleIf: (form) => form.generator === "Logo",
        help: "Only used by the Logo block — feeds the sidebar footer and the Home page standings heading.",
      },
    ],
  };
}

function newsMeta() {
  const today = isoDate(new Date());
  const earliestPublishDate = addDays(today, 1);
  return {
    label: "News",
    group: "Content",
    noun: "story",
    newLabel: "New story",
    blurb: "Posts on the home page. Plain News sorts newest-first and can't be dated in the future; Events sort soonest-first and must be dated in the future.",
    searchHint: "Search headline",
    emptyTitle: "No stories yet",
    emptyBody: "Write a recap after the next game and it appears on the home page.",
    idKey: "post_id",
    reorder: false,
    listPath: () => "/news",
    itemPath: (item) => `/news/${encodeURIComponent(item.post_id)}`,
    createPath: () => "/news",
    nameOf: (item) => item.title,
    columns: [
      { label: "Photo", key: "image", style: "width:70px", render: (item) => ({ kind: "photo", url: item.image }) },
      { label: "Headline", key: "title", render: (item) => ({ kind: "plain", strong: true, text: item.title || "" }) },
      { label: "Event", key: "is_event", style: "width:90px", render: (item) => ({ kind: "plain", text: item.is_event ? "Yes" : "" }) },
      { label: "Published", key: "published_date", style: "width:120px", render: (item) => ({ kind: "plain", text: item.published_date || "" }) },
      { label: "End date", key: "end_date", style: "width:120px", render: (item) => ({ kind: "plain", text: item.end_date || "" }) },
    ],
    fields: [
      { key: "title", label: "Headline", type: "text", required: true, span: 2, placeholder: "Panthers open league play with a road win" },
      { key: "is_event", label: "Event", type: "checkbox", checkLabel: "Event (upcoming, must be dated in the future)", span: 1 },
      { key: "published_date", label: "Published date", type: "date", required: true, span: 1, help: "Events must be in the future; plain News can't be." },
      { key: "end_date", label: "End date", type: "date", span: 1, help: "Must be after the published date." },
      { key: "body", label: "Story", type: "textarea", span: 2, placeholder: "A 14-2 run to close the third quarter decided it." },
      { key: "image", label: "Photo", type: "file", span: 2 },
    ],
    validate(values) {
      if (values.is_event && values.published_date && values.published_date <= today) return "Published date must be in the future for events.";
      if (!values.is_event && values.published_date && values.published_date > today) return "Published date can't be in the future for news.";
      if (values.end_date && values.published_date && values.end_date <= values.published_date) return "End date must be after the published date.";
      return null;
    },
  };
}

function coachesMeta() {
  return {
    label: "Coaches",
    group: "Teams",
    noun: "coach",
    newLabel: "New coach",
    blurb: "Staff listed on the Coaches page. Email addresses are published.",
    searchHint: "Search name or role",
    emptyTitle: "No coaches yet",
    emptyBody: "Add the head coach first — teams reference this list.",
    idKey: "coach_id",
    reorder: true,
    listPath: () => "/coaches",
    itemPath: (item) => `/coaches/${encodeURIComponent(item.coach_id)}`,
    createPath: () => "/coaches",
    nameOf: (item) => item.name,
    columns: [
      { label: "Portrait", key: "image", style: "width:70px", render: (item) => ({ kind: "photo", url: item.image }) },
      { label: "Name", key: "name", render: (item) => ({ kind: "plain", strong: true, text: item.name || "" }) },
      { label: "Role", key: "title", render: (item) => ({ kind: "plain", text: item.title || "" }) },
      { label: "Email", key: "email", render: (item) => ({ kind: "plain", text: item.email || "" }) },
    ],
    fields: [
      { key: "name", label: "Name", type: "text", required: true, span: 1 },
      { key: "title", label: "Role", type: "text", span: 1, placeholder: "Head Coach" },
      { key: "email", label: "Email", type: "email", span: 1, placeholder: "name@npanthers.org" },
      { key: "image", label: "Portrait", type: "file", span: 1 },
      { key: "profile", label: "Profile", type: "textarea", span: 2 },
    ],
  };
}

function contactsMeta() {
  return {
    label: "Contacts",
    group: "Teams",
    noun: "contact",
    newLabel: "New contact",
    blurb: "The Contact page list. Email, phone and social links are rendered as links.",
    searchHint: "Search contact",
    emptyTitle: "No contacts yet",
    emptyBody: "Add the athletics office so parents have somewhere to start.",
    idKey: "contact_id",
    reorder: true,
    listPath: () => "/contacts",
    itemPath: (item) => `/contacts/${encodeURIComponent(item.contact_id)}`,
    createPath: () => "/contacts",
    nameOf: (item) => item.label,
    columns: [
      { label: "Kind", key: "kind", style: "width:120px", render: (item) => ({ kind: "flag", text: item.kind || "" }) },
      { label: "Name", key: "label", render: (item) => ({ kind: "plain", strong: true, text: item.label || "" }) },
      { label: "For", key: "role", render: (item) => ({ kind: "plain", text: item.role || "" }) },
      { label: "Type", key: "type", style: "width:130px", render: (item) => ({ kind: "plain", text: item.type || "" }) },
      { label: "Value", key: "value", render: (item) => ({ kind: "plain", text: item.value || "" }) },
    ],
    fields: [
      { key: "kind", label: "Kind", type: "select", options: CONTACT_KINDS, span: 1 },
      { key: "label", label: "Name", type: "text", required: true, span: 1, placeholder: "General Info" },
      { key: "role", label: "What it's for", type: "text", span: 2, placeholder: "Eligibility, clearance, transcripts" },
      { key: "type", label: "Type", type: "select", options: CONTACT_TYPES, span: 1 },
      { key: "value", label: "Email, phone, address or handle", type: "textarea", required: true, span: 2 },
    ],
  };
}

function sponsorsMeta() {
  return {
    label: "Sponsors",
    group: "Season",
    noun: "sponsor",
    newLabel: "New sponsor",
    blurb: "Businesses supporting the program this season, grouped by level on the public page.",
    searchHint: "Search sponsor",
    emptyTitle: "No sponsors yet",
    emptyBody: "Add a sponsor and they appear on the home page and the Sponsors page.",
    idKey: "sponsor_id",
    reorder: true,
    listPath: () => "/sponsors",
    itemPath: (item) => `/sponsors/${encodeURIComponent(item.sponsor_id)}`,
    createPath: () => "/sponsors",
    nameOf: (item) => item.name,
    columns: [
      { label: "Sponsor", key: "name", render: (item) => ({ kind: "plain", strong: true, text: item.name || "" }) },
      { label: "Level", key: "tier", style: "width:170px", render: (item) => ({ kind: "flag", text: item.tier || "" }) },
      { label: "Business", key: "kind", render: (item) => ({ kind: "plain", text: item.kind || "" }) },
      { label: "Website", key: "website", render: (item) => ({ kind: "plain", text: item.website || "" }) },
    ],
    fields: [
      { key: "name", label: "Sponsor name", type: "text", required: true, span: 2 },
      { key: "tier", label: "Level", type: "select", options: SPONSOR_TIERS, span: 1 },
      { key: "kind", label: "Business", type: "text", span: 1, placeholder: "Orthodontics · Thousand Oaks" },
      { key: "website", label: "Website", type: "text", span: 2, placeholder: "https://conejovalleyortho.com" },
    ],
  };
}

function rostersMeta() {
  return {
    label: "Rosters",
    group: "Teams",
    noun: "team",
    newLabel: "New team",
    blurb: "The three teams and who coaches them. Open Players to manage a team's roster.",
    searchHint: "Search team",
    emptyTitle: "No teams yet",
    emptyBody: "Add Varsity, Junior Varsity and Frosh to start the season.",
    idKey: "team_id",
    reorder: true,
    listPath: () => "/rosters",
    itemPath: (item) => `/rosters/${encodeURIComponent(item.team_id)}`,
    createPath: () => "/rosters",
    nameOf: (item) => item.name,
    columns: [
      { label: "Photo", key: "image", style: "width:70px", render: (item) => ({ kind: "photo", url: item.image }) },
      { label: "Team", key: "name", render: (item) => ({ kind: "plain", strong: true, text: item.name || "" }) },
      {
        label: "Coaches",
        key: "coach_ids",
        render: (item, ctx) => ({ kind: "plain", text: (item.coach_ids || []).map((id) => ctx.coachesById?.[id]?.name).filter(Boolean).join(", ") }),
      },
      { label: "Description", key: "description", render: (item) => ({ kind: "plain", text: (item.description || "").slice(0, 64) }) },
    ],
    fields: async () => {
      const coaches = await apiFetch("/coaches");
      return [
        { key: "name", label: "Team name", type: "text", required: true, span: 1, placeholder: "Varsity" },
        { key: "image", label: "Team photo", type: "file", span: 1 },
        { key: "description", label: "Description", type: "textarea", span: 2 },
        { key: "coach_ids", label: "Coaches", type: "multi", span: 2, options: coaches.map((c) => ({ value: c.coach_id, label: c.name })) },
      ];
    },
    extraActions: (item, ctx) => [{ label: "Players", onClick: () => ctx.openPlayers(item) }],
  };
}

function playersMeta(team, back) {
  return {
    label: `Players — ${team.name || "(unnamed team)"}`,
    noun: "player",
    newLabel: "New player",
    blurb: "Players on this roster. Number, height and year appear on the public team page.",
    searchHint: "Search name or number",
    emptyTitle: "No players yet",
    emptyBody: "Add players one at a time, or ask the coach for the tryout list.",
    idKey: "player_id",
    reorder: false,
    backLabel: "← Rosters",
    backAction: back,
    listPath: () => `/players/${encodeURIComponent(team.team_id)}`,
    itemPath: (item) => `/players/${encodeURIComponent(team.team_id)}/${encodeURIComponent(item.player_id)}`,
    createPath: () => `/players/${encodeURIComponent(team.team_id)}`,
    nameOf: (item) => `${item.first_name || ""} ${item.last_name || ""}`.trim(),
    columns: [
      { label: "Photo", key: "image", style: "width:70px", render: (item) => ({ kind: "photo", url: item.image }) },
      { label: "#", key: "number", style: "width:60px", kind: "num", render: (item) => ({ kind: "plain", text: item.number || "" }) },
      { label: "First name", key: "first_name", render: (item) => ({ kind: "plain", strong: true, text: item.first_name || "" }) },
      { label: "Last name", key: "last_name", render: (item) => ({ kind: "plain", strong: true, text: item.last_name || "" }) },
      { label: "Height", key: "height", style: "width:90px", render: (item) => ({ kind: "plain", text: item.height || "" }) },
      { label: "Year", key: "year", style: "width:130px", render: (item) => ({ kind: "flag", text: item.year || "" }) },
    ],
    fields: [
      { key: "first_name", label: "First name", type: "text", required: true, span: 1 },
      { key: "last_name", label: "Last name", type: "text", required: true, span: 1 },
      { key: "number", label: "Jersey number", type: "text", span: 1 },
      { key: "height", label: "Height", type: "text", span: 1, placeholder: "6'2\"" },
      { key: "year", label: "Year", type: "select", options: PLAYER_YEARS, span: 1 },
      { key: "image", label: "Photo", type: "file", span: 1 },
      { key: "profile", label: "Profile", type: "textarea", span: 2, placeholder: "Notes shown on the player's public listing." },
    ],
  };
}

function albumsMeta() {
  return {
    label: "Photos",
    group: "Content",
    noun: "album",
    newLabel: "New album",
    blurb: "Albums shown on the Photos page. Open Photos to add pictures to one.",
    searchHint: "Search album",
    emptyTitle: "No albums yet",
    emptyBody: "Create an album for game night, then add pictures to it.",
    idKey: "album_id",
    reorder: true,
    listPath: () => "/albums",
    itemPath: (item) => `/albums/${encodeURIComponent(item.album_id)}`,
    createPath: () => "/albums",
    nameOf: (item) => item.title,
    columns: [
      { label: "Title", key: "title", render: (item) => ({ kind: "plain", strong: true, text: item.title || "" }) },
      { label: "Date label", key: "date_label", render: (item) => ({ kind: "plain", text: item.date_label || "" }) },
    ],
    fields: [
      { key: "title", label: "Title", type: "text", required: true, span: 1, placeholder: "At Oaks Christian" },
      { key: "date_label", label: "Date label", type: "text", span: 1, placeholder: "Jan 8, or Dec 20–22" },
    ],
    extraActions: (item, ctx) => [{ label: "Photos", onClick: () => ctx.openPhotos(item) }],
  };
}

function photosMeta(album, back) {
  return {
    label: `Photos — ${album.title || ""}`,
    noun: "photo",
    newLabel: "Upload photo",
    blurb: "Candid shots for this album, at their natural aspect ratio (not cropped).",
    searchHint: "Search caption",
    emptyTitle: "No photos yet",
    emptyBody: "Upload game night shots for this album.",
    idKey: "photo_id",
    reorder: true,
    backLabel: "← Photos",
    backAction: back,
    listPath: () => `/photos/${encodeURIComponent(album.album_id)}`,
    itemPath: (item) => `/photos/${encodeURIComponent(album.album_id)}/${encodeURIComponent(item.photo_id)}`,
    createPath: () => `/photos/${encodeURIComponent(album.album_id)}`,
    nameOf: () => "photo",
    columns: [
      { label: "Image", key: "image", style: "width:70px", render: (item) => ({ kind: "photo", url: item.image }) },
      { label: "Caption", key: "caption", render: (item) => ({ kind: "plain", strong: true, text: item.caption || "" }) },
    ],
    fields: [
      { key: "image", label: "Image", type: "file", raw: true, required: true, span: 2 },
      { key: "caption", label: "Caption", type: "text", span: 2, placeholder: "Fourth quarter, 68–61." },
    ],
  };
}

/* ============================== Schedule =============================== */

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

async function renderScheduleSection(container) {
  container.innerHTML = "";
  let season = defaultSeason();
  let view = "list";
  let teamFilter = "All teams";
  let calYear = null;
  let calMonth = null;
  let teams = [];
  let games = [];

  const head = el("div", { class: "ad-section-head" }, [
    el("div", {}, [el("h1", { text: "Schedule" }), el("p", { class: "ad-section-blurb", text: "Every game for the season, all three teams. Enter scores after the game and the result posts itself." })]),
    el("button", { type: "button", class: "btn btn-primary", text: "New game" }).also((b) => b.addEventListener("click", () => openGameModal(null))),
  ]);
  container.appendChild(head);

  const seasonRow = el("div", { class: "ad-tools-row" });
  const seasonInput = el("input", { class: "ad-input", style: "max-width:140px", value: season });
  const loadBtn = el("button", { type: "button", class: "btn btn-secondary", text: "Load" });
  seasonRow.appendChild(el("div", { class: "ad-tools-group" }, [el("span", { class: "ad-tools-label", text: "Season" }), seasonInput, loadBtn]));
  container.appendChild(seasonRow);

  const toolsRow = el("div", { class: "ad-tools-row" });
  container.appendChild(toolsRow);

  const bodyBox = el("div", {});
  container.appendChild(bodyBox);

  loadBtn.addEventListener("click", () => {
    season = seasonInput.value.trim() || defaultSeason();
    calYear = null;
    refresh();
  });

  function fields() {
    return [
      { key: "date", label: "Date", type: "date", required: true, span: 1 },
      { key: "time", label: "Tip-off", type: "text", span: 1, placeholder: "7:00 PM or TBA" },
      { key: "opponent", label: "Opponent", type: "text", required: true, span: 1 },
      { key: "home_away", label: "Home or away", type: "select", options: ["Home", "Away"], span: 1 },
      { key: "team_id", label: "Team", type: "select", options: [{ value: "", label: "(none)" }, ...teams.map((t) => ({ value: t.team_id, label: t.name || "" }))], span: 1 },
      { key: "is_league", label: "League game", type: "checkbox", checkLabel: "Counts toward league standings", span: 1 },
      { key: "location", label: "Location", type: "text", placeholder: "Oaks Christian HS", span: 1, visibleIf: (f) => f.home_away === "Away" },
      { key: "address", label: "Address (for Google Maps)", type: "text", span: 1, visibleIf: (f) => f.home_away === "Away" },
      { key: "our_score", label: "Our score", type: "number", span: 1, help: "Leave both scores blank until the game is played." },
      { key: "opponent_score", label: "Opponent score", type: "number", span: 1 },
    ];
  }

  function openGameModal(game) {
    openModal({
      title: game ? "Edit game" : "New game",
      fields: fields(),
      initialValues: game || { home_away: "Home", team_id: teams[0]?.team_id || "" },
      saveLabel: game ? "Save changes" : "Create game",
      onSave: async (values) => {
        const path = game ? `/schedule/${encodeURIComponent(season)}/${encodeURIComponent(game.game_id)}` : `/schedule/${encodeURIComponent(season)}`;
        await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
        showToast(game ? "Changes saved" : "Game created");
        await refresh();
      },
    });
  }

  function teamName(id) {
    return teams.find((t) => t.team_id === id)?.name || "";
  }

  function filteredGames() {
    return teamFilter === "All teams" ? games : games.filter((g) => teamName(g.team_id) === teamFilter);
  }

  function paintToolsRow() {
    toolsRow.innerHTML = "";
    const teamGroup = el("div", { class: "ad-tools-group" }, [el("span", { class: "ad-tools-label", text: "Team" })]);
    const teamTabs = el("div", { style: "display:flex;gap:6px" });
    ["All teams", ...teams.map((t) => t.name || "")].forEach((name) => {
      teamTabs.appendChild(
        el("button", { type: "button", class: "ad-tab" + (teamFilter === name ? " is-on" : ""), text: name === "Junior Varsity" ? "JV" : name }).also((b) =>
          b.addEventListener("click", () => {
            teamFilter = name;
            paintAll();
          })
        )
      );
    });
    teamGroup.appendChild(teamTabs);

    const viewGroup = el("div", { class: "ad-tools-group" }, [el("span", { class: "ad-tools-label", text: "View" })]);
    const viewTabs = el("div", { style: "display:flex;gap:6px" }, [
      el("button", { type: "button", class: "ad-tab" + (view === "list" ? " is-on" : ""), text: "List" }).also((b) => b.addEventListener("click", () => setView("list"))),
      el("button", { type: "button", class: "ad-tab" + (view === "calendar" ? " is-on" : ""), text: "Calendar" }).also((b) => b.addEventListener("click", () => setView("calendar"))),
    ]);
    viewGroup.appendChild(viewTabs);

    toolsRow.appendChild(teamGroup);
    toolsRow.appendChild(viewGroup);
  }

  function setView(v) {
    view = v;
    paintAll();
  }

  let listSort = null;

  function resultText(g) {
    if (g.our_score === "" || g.our_score == null || g.our_score === undefined) return "";
    const win = Number(g.our_score) > Number(g.opponent_score);
    return `${win ? "W" : "L"} ${g.our_score}–${g.opponent_score}`;
  }

  function paintList() {
    bodyBox.innerHTML = "";
    const teamsById = Object.fromEntries(teams.map((t) => [t.team_id, t]));
    const columns = [
      { label: "Date", key: "date", text: (g) => g.date || "" },
      { label: "Time", key: "time", text: (g) => g.time || "" },
      { label: "Team", key: "team_id", text: (g) => teamsById[g.team_id]?.name || "", flag: true },
      { label: "Opponent", key: "opponent", text: (g) => `${g.home_away === "Home" ? "vs" : "at"} ${g.opponent || ""}`, strong: true },
      { label: "Result", key: "our_score", text: resultText },
      { label: "League", key: "is_league", text: (g) => (g.is_league ? "Yes" : "") },
    ];

    let rows = filteredGames();
    if (listSort) {
      const col = columns.find((c) => c.key === listSort.key);
      rows = rows.slice().sort((a, b) => {
        const av = col.text(a),
          bv = col.text(b);
        const na = parseFloat(String(av).replace(/[^0-9.\-]/g, "")),
          nb = parseFloat(String(bv).replace(/[^0-9.\-]/g, ""));
        const cmp = !isNaN(na) && !isNaN(nb) && av !== "" && bv !== "" ? na - nb : String(av).localeCompare(String(bv));
        return listSort.dir === "asc" ? cmp : -cmp;
      });
    } else {
      rows = rows.slice().sort((a, b) => String(a.date || "").localeCompare(b.date || ""));
    }

    bodyBox.appendChild(el("p", { class: "ad-count", style: "margin:0 0 12px", text: `${rows.length} ${rows.length === 1 ? "game" : "games"}` }));

    if (!rows.length) {
      bodyBox.appendChild(
        el("div", { class: "ad-empty" }, [
          el("div", { class: "ad-empty-title", text: "No games yet" }),
          el("p", { class: "ad-empty-body", text: "Add the first game of the season, or paste the league slate." }),
          el("button", { type: "button", class: "btn btn-primary", text: "New game" }).also((b) => b.addEventListener("click", () => openGameModal(null))),
        ])
      );
      return;
    }

    const thead = el("thead", {}, [
      el(
        "tr",
        {},
        columns
          .map((c) => {
            const active = listSort && listSort.key === c.key;
            const label = el("button", { type: "button", class: "ad-sort", text: c.label + (active ? (listSort.dir === "asc" ? " ▲" : " ▼") : "") });
            label.addEventListener("click", () => {
              listSort = active && listSort.dir === "asc" ? { key: c.key, dir: "desc" } : { key: c.key, dir: "asc" };
              paintList();
            });
            return el("th", {}, [label]);
          })
          .concat([el("th", { style: "width:120px", text: "Actions" })])
      ),
    ]);

    const tbody = el("tbody");
    rows.forEach((g) => {
      const tds = columns.map((c) => {
        const text = c.text(g);
        const td = el("td", {});
        if (c.flag && text) td.appendChild(el("span", { class: "tag tag-outline", text }));
        else if (text) td.appendChild(el("span", { style: c.strong ? "font-family:var(--font-heading);font-size:17px" : "", text }));
        else td.appendChild(el("span", { class: "ad-muted-cell", text: "—" }));
        return td;
      });
      const actions = el("div", { class: "ad-actions" }, [
        el("button", { type: "button", class: "btn btn-secondary", text: "Edit" }).also((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            openGameModal(g);
          })
        ),
        el("button", { type: "button", class: "btn btn-secondary ad-del", text: "Delete" }).also((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            openConfirm({
              noun: "game",
              name: g.opponent || "game",
              onConfirm: async () => {
                await apiFetch(`/schedule/${encodeURIComponent(season)}/${encodeURIComponent(g.game_id)}`, { method: "DELETE" });
                showToast("Game deleted");
                await refresh();
              },
            });
          })
        ),
      ]);
      const row = el("tr", {}, [...tds, el("td", {}, [actions])]);
      row.addEventListener("click", () => openGameModal(g));
      tbody.appendChild(row);
    });

    bodyBox.appendChild(el("div", { class: "ad-tbl-wrap" }, [el("table", { class: "ad-tbl" }, [thead, tbody])]));
  }

  function paintCalendar() {
    bodyBox.innerHTML = "";
    const list = filteredGames();
    if (calYear === null) {
      const earliest = list.reduce((min, g) => (g.date && (!min || g.date < min) ? g.date : min), null);
      const [y, m] = (earliest || isoDate(new Date())).split("-").map(Number);
      calYear = y;
      calMonth = m - 1;
    }
    const teamsById = Object.fromEntries(teams.map((t) => [t.team_id, t]));
    const gamesByDate = {};
    list.forEach((g) => {
      if (g.date) (gamesByDate[g.date] ||= []).push(g);
    });

    const monthLabel = new Date(calYear, calMonth, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
    const prevBtn = el("button", { type: "button", class: "btn btn-ghost", text: "← Prev" }).also((b) =>
      b.addEventListener("click", () => {
        calMonth -= 1;
        if (calMonth < 0) {
          calMonth = 11;
          calYear -= 1;
        }
        paintCalendar();
      })
    );
    const nextBtn = el("button", { type: "button", class: "btn btn-ghost", text: "Next →" }).also((b) =>
      b.addEventListener("click", () => {
        calMonth += 1;
        if (calMonth > 11) {
          calMonth = 0;
          calYear += 1;
        }
        paintCalendar();
      })
    );

    const grid = el("div", { class: "ad-cal-grid" });
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => grid.appendChild(el("div", { class: "ad-cal-dow", text: d })));

    const firstOfMonth = new Date(calYear, calMonth, 1);
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    for (let i = 0; i < firstOfMonth.getDay(); i++) grid.appendChild(el("div", { class: "ad-cal-cell is-outside" }));

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const cell = el("div", { class: "ad-cal-cell" }, [el("div", { class: "ad-cal-daynum", text: String(day) })]);
      cell.addEventListener("click", () => openGameModal(null));
      (gamesByDate[iso] || []).forEach((g) => {
        const teamName2 = teamsById[g.team_id]?.name;
        const label = [g.time || "TBA", g.home_away === "Home" ? "vs" : "at", g.opponent, teamName2 && `(${teamName2})`].filter(Boolean).join(" ");
        cell.appendChild(
          el("button", { type: "button", class: "ad-cal-event", text: label }).also((btn) =>
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              openGameModal(g);
            })
          )
        );
      });
      grid.appendChild(cell);
    }

    bodyBox.appendChild(el("div", { class: "ad-cal-header" }, [prevBtn, el("div", { class: "ad-cal-label", text: monthLabel }), nextBtn]));
    bodyBox.appendChild(grid);
    bodyBox.appendChild(el("p", { class: "ad-help", style: "margin-top:12px", text: "Click a day to add a game on that date, or a game to edit it." }));
  }

  function paintAll() {
    paintToolsRow();
    if (view === "list") paintList();
    else paintCalendar();
  }

  async function refresh() {
    [games, teams] = await Promise.all([apiFetch(`/schedule/${encodeURIComponent(season)}`), apiFetch("/rosters")]);
    paintAll();
  }

  await refresh();
}

/* ============================== Standings =============================== */

const STANDINGS_FIELDS = [
  { key: "school", label: "School", type: "text", required: true, span: 2 },
  { key: "rank", label: "Rank", type: "text", span: 1 },
  { key: "streak", label: "Streak", type: "text", placeholder: "W3", span: 1 },
  { key: "league_record", label: "League W-L", type: "text", placeholder: "8-2", span: 1 },
  { key: "league_pct", label: "League PCT", type: "text", placeholder: "0.800", span: 1 },
  { key: "league_pf", label: "League PF", type: "number", span: 1 },
  { key: "league_pa", label: "League PA", type: "number", span: 1 },
  { key: "overall_record", label: "Overall W-L", type: "text", placeholder: "23-6", span: 1 },
  { key: "overall_pct", label: "Overall PCT", type: "text", placeholder: "0.793", span: 1 },
  { key: "overall_pf", label: "Overall PF", type: "number", span: 1 },
  { key: "overall_pa", label: "Overall PA", type: "number", span: 1 },
  { key: "link", label: "Link", type: "text", placeholder: "https://...", span: 2, help: "The school's own site — never scraped, preserved across refreshes." },
];

async function renderStandingsSection(container) {
  container.innerHTML = "";
  let rows = [];

  const head = el("div", { class: "ad-section-head" }, [
    el("div", {}, [
      el("h1", { text: "League Standings" }),
      el("p", { class: "ad-section-blurb", text: "Marmonte League table shown on the home page. Pulled from MaxPreps, editable by hand." }),
    ]),
    el("button", { type: "button", class: "btn btn-primary", text: "Add school" }).also((b) => b.addEventListener("click", () => openSchoolModal(null))),
  ]);
  container.appendChild(head);

  const toolsBox = el("div", {});
  container.appendChild(toolsBox);
  const tableBox = el("div", {});
  container.appendChild(tableBox);

  async function persistRows(newRows) {
    const fresh = await apiFetch("/standings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: newRows }) });
    if (fresh && fresh.error) throw new Error(fresh.error);
    return fresh;
  }

  function openSchoolModal(row) {
    openModal({
      title: row ? "Edit school" : "Add school",
      fields: STANDINGS_FIELDS,
      initialValues: row || {},
      saveLabel: row ? "Save changes" : "Add school",
      onSave: async (values) => {
        const newRows = row ? rows.map((r) => (r === row ? { ...r, ...values } : r)) : [...rows, values];
        const fresh = await persistRows(newRows);
        showToast(row ? "Changes saved" : "School added");
        paint(fresh);
      },
    });
  }

  function paintTools(cache) {
    toolsBox.innerHTML = "";
    const sourceInput = el("input", { class: "ad-input", value: cache?.source_url || "" });
    const refreshBtn = el("button", { type: "button", class: "btn btn-secondary", text: "Refresh from source" });
    const refreshErrorEl = el("p", { class: "ad-help", style: "color:#8c2f21" });
    refreshErrorEl.hidden = true;
    const updatedText = cache?.updated_at ? `Last updated ${new Date(cache.updated_at * 1000).toLocaleString()}` : "Never refreshed yet";

    refreshBtn.addEventListener("click", async () => {
      refreshErrorEl.hidden = true;
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Refreshing…";
      try {
        const fresh = await apiFetch("/standings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_url: sourceInput.value }) });
        if (fresh && fresh.error) throw new Error(fresh.error);
        showToast("Standings refreshed from MaxPreps");
        paint(fresh);
      } catch (err) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Refresh from source";
        refreshErrorEl.textContent = `Refresh failed: ${err.message}`;
        refreshErrorEl.hidden = false;
      }
    });

    toolsBox.appendChild(
      el("div", { class: "ad-standings-tools" }, [
        el("div", { class: "ad-field" }, [el("label", { class: "ad-lbl", text: "Source (MaxPreps)" }), sourceInput]),
        refreshBtn,
        el("div", { class: "ad-standings-updated", text: updatedText }),
      ])
    );
    toolsBox.appendChild(refreshErrorEl);
    toolsBox.appendChild(
      el("p", { class: "ad-help", style: "margin:8px 0 0" }, [
        document.createTextNode("Refreshing from the source overwrites every manual edit except Link, which is never scraped."),
      ])
    );
  }

  function paintTable() {
    tableBox.innerHTML = "";
    if (!rows.length) {
      tableBox.appendChild(
        el("div", { class: "ad-empty" }, [
          el("div", { class: "ad-empty-title", text: "No schools yet" }),
          el("p", { class: "ad-empty-body", text: "Refresh from MaxPreps, or add the league's schools by hand." }),
          el("button", { type: "button", class: "btn btn-primary", text: "Add school" }).also((b) => b.addEventListener("click", () => openSchoolModal(null))),
        ])
      );
      return;
    }

    const columns = [
      { label: "School", text: (r) => r.school || "", strong: true },
      { label: "League W-L", text: (r) => r.league_record || "" },
      { label: "League PCT", text: (r) => r.league_pct || "" },
      { label: "Overall W-L", text: (r) => r.overall_record || "" },
      { label: "Overall PCT", text: (r) => r.overall_pct || "" },
      { label: "Streak", text: (r) => r.streak || "", flag: true },
    ];

    const thead = el("thead", {}, [el("tr", {}, [...columns.map((c) => el("th", { text: c.label })), el("th", { style: "width:120px", text: "Actions" })])]);
    const tbody = el("tbody");
    rows.forEach((row) => {
      const tds = columns.map((c) => {
        const text = c.text(row);
        const td = el("td", {});
        if (c.flag && text) td.appendChild(el("span", { class: "tag tag-outline", text }));
        else if (text) td.appendChild(el("span", { style: c.strong ? "font-family:var(--font-heading);font-size:17px" : "", text }));
        else td.appendChild(el("span", { class: "ad-muted-cell", text: "—" }));
        return td;
      });
      const actions = el("div", { class: "ad-actions" }, [
        el("button", { type: "button", class: "btn btn-secondary", text: "Edit" }).also((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            openSchoolModal(row);
          })
        ),
        el("button", { type: "button", class: "btn btn-secondary ad-del", text: "Delete" }).also((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            openConfirm({
              noun: "school",
              name: row.school || "school",
              onConfirm: async () => {
                const fresh = await persistRows(rows.filter((r) => r !== row));
                showToast("School deleted");
                paint(fresh);
              },
            });
          })
        ),
      ]);
      const tr = el("tr", {}, [...tds, el("td", {}, [actions])]);
      tr.addEventListener("click", () => openSchoolModal(row));
      tbody.appendChild(tr);
    });

    tableBox.appendChild(el("div", { class: "ad-tbl-wrap" }, [el("table", { class: "ad-tbl" }, [thead, tbody])]));
  }

  function paint(cache) {
    rows = cache?.rows || [];
    paintTools(cache);
    paintTable();
  }

  const cache = await apiFetch("/standings");
  paint(cache);
}

/* ======================= Rosters (with Players drill) =================== */

async function renderRostersSection(container, driveTo) {
  const meta = rostersMeta();
  const coaches = await apiFetch("/coaches");
  await renderGenericSection(container, meta, {
    openPlayers: (team) => driveTo({ kind: "players", team }),
    coachesById: Object.fromEntries(coaches.map((c) => [c.coach_id, c])),
  });
}

async function renderAlbumsSection(container, driveTo) {
  const meta = albumsMeta();
  await renderGenericSection(container, meta, {
    openPhotos: (album) => driveTo({ kind: "photos", album }),
  });
}

/* ============================== Dashboard =============================== */

const NAV_GROUPS = ["Content", "Teams", "Season"];
const SECTION_ORDER = ["content-blocks", "news", "photos", "rosters", "coaches", "contacts", "schedule", "sponsors", "standings"];
const SECTION_LABELS = {
  "content-blocks": { label: "Content Blocks", group: "Content" },
  news: { label: "News", group: "Content" },
  photos: { label: "Photos", group: "Content" },
  rosters: { label: "Rosters", group: "Teams" },
  coaches: { label: "Coaches", group: "Teams" },
  contacts: { label: "Contacts", group: "Teams" },
  schedule: { label: "Schedule", group: "Season" },
  sponsors: { label: "Sponsors", group: "Season" },
  standings: { label: "League Standings", group: "Season" },
};

function initDashboard() {
  const navGroups = document.getElementById("ad-nav-groups");
  const container = document.getElementById("section-container");
  let currentSection = "content-blocks";
  let drill = null; // { kind: 'players', team } | { kind: 'photos', album }

  function renderNav() {
    navGroups.innerHTML = "";
    NAV_GROUPS.forEach((group) => {
      const keys = SECTION_ORDER.filter((k) => SECTION_LABELS[k].group === group);
      const tabs = el(
        "div",
        { class: "ad-nav-group-tabs" },
        keys.map((key) =>
          el("button", { type: "button", class: "ad-tab" + (currentSection === key && !drill ? " is-on" : ""), text: SECTION_LABELS[key].label }).also((b) =>
            b.addEventListener("click", () => activate(key))
          )
        )
      );
      navGroups.appendChild(el("div", {}, [el("div", { class: "ad-nav-group-label", text: group }), tabs]));
    });
  }

  function driveTo(next) {
    drill = next;
    renderSection();
  }

  function renderSection() {
    container.innerHTML = "";
    if (drill && drill.kind === "players") {
      renderGenericSection(container, playersMeta(drill.team, () => driveTo(null)), {});
      return;
    }
    if (drill && drill.kind === "photos") {
      renderGenericSection(container, photosMeta(drill.album, () => driveTo(null)), {});
      return;
    }
    if (currentSection === "content-blocks") renderGenericSection(container, contentBlocksMeta(), {});
    else if (currentSection === "news") renderGenericSection(container, newsMeta(), {});
    else if (currentSection === "photos") renderAlbumsSection(container, driveTo);
    else if (currentSection === "rosters") renderRostersSection(container, driveTo);
    else if (currentSection === "coaches") renderGenericSection(container, coachesMeta(), {});
    else if (currentSection === "contacts") renderGenericSection(container, contactsMeta(), {});
    else if (currentSection === "schedule") renderScheduleSection(container);
    else if (currentSection === "sponsors") renderGenericSection(container, sponsorsMeta(), {});
    else if (currentSection === "standings") renderStandingsSection(container);
  }

  function activate(key) {
    currentSection = key;
    drill = null;
    renderNav();
    renderSection();
  }

  renderNav();
  renderSection();
}
