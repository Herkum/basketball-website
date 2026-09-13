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

// Crop viewport IS the output image: whatever is drawn onto the canvas at
// its native resolution is exactly what gets uploaded, so "cropping" is just
// toBlob() on the canvas - no separate crop-rectangle math needed.
function createImageField(existingUrl) {
  const CANVAS_SIZE = 320;
  let currentUrl = existingUrl || "";

  const wrapper = el("div", { class: "image-field" });
  const preview = el("img", { class: "image-preview" });
  preview.src = currentUrl;
  preview.hidden = !currentUrl;

  const fileInput = el("input", { type: "file", accept: "image/*" });
  const canvas = el("canvas", { width: String(CANVAS_SIZE), height: String(CANVAS_SIZE), class: "crop-canvas" });
  const zoomRange = el("input", { type: "range", min: "1", max: "3", step: "0.01", value: "1" });
  const applyBtn = el("button", { type: "button", text: "Use this photo" });
  const cancelBtn = el("button", { type: "button", text: "Cancel" });
  const errorEl = el("p", { class: "field-error" });
  errorEl.hidden = true;
  const cropperBox = el("div", { class: "cropper-box" }, [
    canvas,
    zoomRange,
    el("div", { class: "cropper-actions" }, [applyBtn, cancelBtn]),
    errorEl,
  ]);
  cropperBox.hidden = true;

  wrapper.appendChild(preview);
  wrapper.appendChild(fileInput);
  wrapper.appendChild(cropperBox);

  const ctx = canvas.getContext("2d");
  let img = null;
  let baseScale = 1;
  let scale = 1;
  let dx = 0;
  let dy = 0;

  function clamp() {
    const w = img.width * scale;
    const h = img.height * scale;
    dx = Math.min(0, Math.max(dx, CANVAS_SIZE - w));
    dy = Math.min(0, Math.max(dy, CANVAS_SIZE - h));
  }

  function draw() {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(img, dx, dy, img.width * scale, img.height * scale);
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    img = new Image();
    img.onload = () => {
      baseScale = Math.max(CANVAS_SIZE / img.width, CANVAS_SIZE / img.height);
      scale = baseScale;
      dx = (CANVAS_SIZE - img.width * scale) / 2;
      dy = (CANVAS_SIZE - img.height * scale) / 2;
      zoomRange.value = "1";
      cropperBox.hidden = false;
      draw();
    };
    img.src = URL.createObjectURL(file);
  });

  zoomRange.addEventListener("input", () => {
    scale = baseScale * Number(zoomRange.value);
    clamp();
    draw();
  });

  // Pointer Events + setPointerCapture instead of mousedown/window-level
  // mousemove: capture keeps receiving move events for this pointer even
  // once it leaves the canvas (or the whole window), so a fast or wide drag
  // never "drops" and leaves the image stuck. Deltas are computed straight
  // from clientX/clientY, so no dependence on a getBoundingClientRect()
  // snapshot going stale mid-drag.
  canvas.addEventListener("pointerdown", (startEvent) => {
    startEvent.preventDefault();
    canvas.setPointerCapture(startEvent.pointerId);
    const start = { x: startEvent.clientX, y: startEvent.clientY, dx, dy };

    function onMove(moveEvent) {
      dx = start.dx + (moveEvent.clientX - start.x);
      dy = start.dy + (moveEvent.clientY - start.y);
      clamp();
      draw();
    }

    function onUp(upEvent) {
      canvas.releasePointerCapture(upEvent.pointerId);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
    }

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
  });

  function blobFromCanvas() {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  }

  // Shared by the "Use this photo" click and by commitPendingCrop() (called
  // on form submit) so choosing a file and hitting Create/Save without ever
  // clicking "Use this photo" still saves the cropped photo instead of
  // silently dropping it.
  async function commitCrop() {
    applyBtn.disabled = true;
    applyBtn.textContent = "Uploading…";
    errorEl.hidden = true;
    try {
      const blob = await blobFromCanvas();
      currentUrl = await uploadImageBlob(blob, "image/jpeg");
      preview.src = currentUrl;
      preview.hidden = false;
      cropperBox.hidden = true;
      fileInput.value = "";
    } catch (err) {
      errorEl.textContent = `Upload failed: ${err.message}`;
      errorEl.hidden = false;
      throw err;
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = "Use this photo";
    }
  }

  applyBtn.addEventListener("click", () => {
    commitCrop().catch(() => {});
  });

  cancelBtn.addEventListener("click", () => {
    cropperBox.hidden = true;
    fileInput.value = "";
  });

  return {
    element: wrapper,
    getValue: () => currentUrl,
    hasPendingCrop: () => !cropperBox.hidden,
    commitPendingCrop: commitCrop,
  };
}

async function renderCoachesSection(container) {
  container.innerHTML = "";
  const formContainer = el("div", { class: "form-container" });
  const tableContainer = el("div", { class: "table-container" });
  container.appendChild(formContainer);
  container.appendChild(tableContainer);

  let editing = null;

  async function persistOrder(items) {
    const updated = items.map((item, index) => ({ ...item, order: index }));
    await Promise.all(
      updated.map((item) =>
        apiFetch(`/coaches/${encodeURIComponent(item.coach_id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      )
    );
  }

  let draggedId = null;

  // Renders synchronously from an in-memory items array (no fetch), so a
  // drop can redraw the new order immediately instead of waiting on the
  // save + refetch round-trip. persistOrder() runs after, in the
  // background; on failure it re-fetches from the server to resync.
  function renderTable(items) {
    tableContainer.innerHTML = "";

    const tbody = el("tbody");
    for (const item of items) {
      const photoCell = el("td");
      if (item.image) photoCell.appendChild(el("img", { src: item.image, class: "thumb" }));

      const row = el("tr", { draggable: "true", class: "draggable-row" }, [
        el("td", { class: "drag-handle", text: "☰" }),
        photoCell,
        el("td", { text: item.name || "" }),
        el("td", { text: item.title || "" }),
        el("td", {}, [
          el("button", { type: "button", text: "Edit" }).also((btn) =>
            btn.addEventListener("click", () => {
              editing = item;
              renderForm();
            })
          ),
          el("button", { type: "button", text: "Delete" }).also((btn) =>
            btn.addEventListener("click", async () => {
              await apiFetch(`/coaches/${encodeURIComponent(item.coach_id)}`, { method: "DELETE" });
              refresh();
            })
          ),
        ]),
      ]);

      row.addEventListener("dragstart", (e) => {
        draggedId = item.coach_id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.coach_id);
        row.classList.add("dragging");
      });

      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("drag-over");
      });

      row.addEventListener("dragleave", () => {
        row.classList.remove("drag-over");
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("drag-over");
        if (!draggedId || draggedId === item.coach_id) return;

        const fromIndex = items.findIndex((i) => i.coach_id === draggedId);
        const toIndex = items.findIndex((i) => i.coach_id === item.coach_id);
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);

        renderTable(items);
        persistOrder(items).catch(() => refresh());
      });

      tbody.appendChild(row);
    }

    const table = el("table", {}, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "" }),
          el("th", { text: "Photo" }),
          el("th", { text: "Name" }),
          el("th", { text: "Title" }),
          el("th", { text: "" }),
        ]),
      ]),
      tbody,
    ]);
    tableContainer.appendChild(table);
  }

  async function refresh() {
    const items = await apiFetch("/coaches");
    renderTable(items);
  }

  function renderForm() {
    formContainer.innerHTML = "";

    const nameInput = el("input", { placeholder: "Name", value: editing?.name || "" });
    const titleInput = el("input", { placeholder: "Title", value: editing?.title || "" });
    const profileInput = el("textarea", { placeholder: "Profile", rows: "4" });
    profileInput.value = editing?.profile || "";
    const imageField = createImageField(editing?.image || "");

    const form = el("form", { class: "item-form coach-form" }, [
      el("label", { text: "Name" }, [nameInput]),
      el("label", { text: "Title" }, [titleInput]),
      el("label", { text: "Profile" }, [profileInput]),
      // plain div, not <label>: a <label> forwards any click inside it
      // (including releasing a drag on the crop canvas) to its first
      // associated control, which would reopen the file picker
      el("div", { class: "photo-field-group" }, [el("span", { text: "Photo" }), imageField.element]),
      el("button", { type: "submit", text: editing ? "Save" : "Create" }),
      ...(editing
        ? [
            el("button", { type: "button", text: "Cancel" }).also((btn) =>
              btn.addEventListener("click", () => {
                editing = null;
                renderForm();
              })
            ),
          ]
        : []),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      // A file was chosen but "Use this photo" was never clicked - finish
      // that crop/upload now rather than silently saving without a photo.
      if (imageField.hasPendingCrop()) {
        try {
          await imageField.commitPendingCrop();
        } catch (err) {
          return;
        }
      }

      const values = {
        name: nameInput.value,
        title: titleInput.value,
        profile: profileInput.value,
        image: imageField.getValue(),
      };
      const path = editing ? `/coaches/${encodeURIComponent(editing.coach_id)}` : "/coaches";
      await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      editing = null;
      renderForm();
      refresh();
    });

    formContainer.appendChild(form);
  }

  renderForm();
  await refresh();
}

const PLAYER_YEARS = ["Freshman", "Sophomore", "Junior", "Senior"];

function buildYearSelect(selected) {
  const select = el("select", {}, PLAYER_YEARS.map((y) => el("option", { value: y, text: y })));
  select.value = selected || PLAYER_YEARS[0];
  return select;
}

async function renderRostersSection(container) {
  container.innerHTML = "";
  const formContainer = el("div", { class: "form-container" });
  const tableContainer = el("div", { class: "table-container" });
  const playersContainer = el("div", { class: "players-panel" });
  container.appendChild(formContainer);
  container.appendChild(tableContainer);
  container.appendChild(playersContainer);

  let editingTeam = null;
  let selectedTeam = null;
  let draggedId = null;

  async function persistTeamOrder(items) {
    const updated = items.map((item, index) => ({ ...item, order: index }));
    await Promise.all(
      updated.map((item) =>
        apiFetch(`/rosters/${encodeURIComponent(item.team_id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      )
    );
  }

  function renderTeamsTable(items, coachesById) {
    tableContainer.innerHTML = "";

    const tbody = el("tbody");
    for (const item of items) {
      const photoCell = el("td");
      if (item.image) photoCell.appendChild(el("img", { src: item.image, class: "thumb" }));

      const coachNames = (item.coach_ids || []).map((id) => coachesById[id]?.name).filter(Boolean).join(", ");

      const row = el("tr", { draggable: "true", class: "draggable-row" }, [
        el("td", { class: "drag-handle", text: "☰" }),
        photoCell,
        el("td", { text: item.name || "" }),
        el("td", { text: coachNames }),
        el("td", {}, [
          el("button", { type: "button", text: "Players" }).also((btn) =>
            btn.addEventListener("click", () => {
              selectedTeam = item;
              renderPlayersPanel();
            })
          ),
          el("button", { type: "button", text: "Edit" }).also((btn) =>
            btn.addEventListener("click", () => {
              editingTeam = item;
              renderTeamForm();
            })
          ),
          el("button", { type: "button", text: "Delete" }).also((btn) =>
            btn.addEventListener("click", async () => {
              await apiFetch(`/rosters/${encodeURIComponent(item.team_id)}`, { method: "DELETE" });
              if (selectedTeam?.team_id === item.team_id) {
                selectedTeam = null;
                playersContainer.innerHTML = "";
              }
              refreshTeams();
            })
          ),
        ]),
      ]);

      row.addEventListener("dragstart", (e) => {
        draggedId = item.team_id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.team_id);
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
        if (!draggedId || draggedId === item.team_id) return;
        const fromIndex = items.findIndex((i) => i.team_id === draggedId);
        const toIndex = items.findIndex((i) => i.team_id === item.team_id);
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        renderTeamsTable(items, coachesById);
        persistTeamOrder(items).catch(() => refreshTeams());
      });

      tbody.appendChild(row);
    }

    tableContainer.appendChild(
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "" }),
            el("th", { text: "Photo" }),
            el("th", { text: "Name" }),
            el("th", { text: "Coaches" }),
            el("th", { text: "" }),
          ]),
        ]),
        tbody,
      ])
    );
  }

  async function refreshTeams() {
    const [items, coaches] = await Promise.all([apiFetch("/rosters"), apiFetch("/coaches")]);
    const coachesById = Object.fromEntries(coaches.map((c) => [c.coach_id, c]));
    renderTeamsTable(items, coachesById);
    return { items, coaches };
  }

  async function renderTeamForm() {
    formContainer.innerHTML = "";
    const coaches = await apiFetch("/coaches");

    const nameInput = el("input", { placeholder: "Name", value: editingTeam?.name || "" });
    const imageField = createImageField(editingTeam?.image || "");
    const selectedCoachIds = new Set(editingTeam?.coach_ids || []);

    const coachCheckboxes = coaches.map((coach) => {
      const checkbox = el("input", { type: "checkbox", value: coach.coach_id });
      checkbox.checked = selectedCoachIds.has(coach.coach_id);
      return el("label", { class: "checkbox-label" }, [checkbox, el("span", { text: coach.name || "" })]).also(
        (label) => (label.dataset.coachId = coach.coach_id)
      );
    });

    const form = el("form", { class: "item-form coach-form" }, [
      el("label", { text: "Name" }, [nameInput]),
      el("div", { class: "photo-field-group" }, [el("span", { text: "Photo" }), imageField.element]),
      el("div", { class: "coaches-field-group" }, [el("span", { text: "Coaches" }), ...coachCheckboxes]),
      el("button", { type: "submit", text: editingTeam ? "Save" : "Create" }),
      ...(editingTeam
        ? [
            el("button", { type: "button", text: "Cancel" }).also((btn) =>
              btn.addEventListener("click", () => {
                editingTeam = null;
                renderTeamForm();
              })
            ),
          ]
        : []),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (imageField.hasPendingCrop()) {
        try {
          await imageField.commitPendingCrop();
        } catch (err) {
          return;
        }
      }

      const coachIds = coachCheckboxes
        .filter((label) => label.querySelector("input").checked)
        .map((label) => label.dataset.coachId);

      const values = {
        name: nameInput.value,
        image: imageField.getValue(),
        coach_ids: coachIds,
      };
      const path = editingTeam ? `/rosters/${encodeURIComponent(editingTeam.team_id)}` : "/rosters";
      await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      editingTeam = null;
      renderTeamForm();
      refreshTeams();
    });

    formContainer.appendChild(form);
  }

  async function renderPlayersPanel() {
    playersContainer.innerHTML = "";
    if (!selectedTeam) return;

    let editingPlayer = null;
    const header = el("div", { class: "players-header" }, [
      el("h2", { text: `Players — ${selectedTeam.name || "(unnamed team)"}` }),
      el("button", { type: "button", text: "Close" }).also((btn) =>
        btn.addEventListener("click", () => {
          selectedTeam = null;
          playersContainer.innerHTML = "";
        })
      ),
    ]);

    const playerFormContainer = el("div", { class: "form-container" });
    const playerTableContainer = el("div", { class: "table-container" });
    playersContainer.appendChild(header);
    playersContainer.appendChild(playerFormContainer);
    playersContainer.appendChild(playerTableContainer);

    async function refreshPlayers() {
      const players = await apiFetch(`/players/${encodeURIComponent(selectedTeam.team_id)}`);
      playerTableContainer.innerHTML = "";
      const tbody = el("tbody");
      for (const player of players) {
        const photoCell = el("td");
        if (player.image) photoCell.appendChild(el("img", { src: player.image, class: "thumb" }));

        tbody.appendChild(
          el("tr", {}, [
            photoCell,
            el("td", { text: player.first_name || "" }),
            el("td", { text: player.last_name || "" }),
            el("td", { text: player.number || "" }),
            el("td", { text: player.height || "" }),
            el("td", { text: player.year || "" }),
            el("td", {}, [
              el("button", { type: "button", text: "Edit" }).also((btn) =>
                btn.addEventListener("click", () => {
                  editingPlayer = player;
                  renderPlayerForm();
                })
              ),
              el("button", { type: "button", text: "Delete" }).also((btn) =>
                btn.addEventListener("click", async () => {
                  await apiFetch(
                    `/players/${encodeURIComponent(selectedTeam.team_id)}/${encodeURIComponent(player.player_id)}`,
                    { method: "DELETE" }
                  );
                  refreshPlayers();
                })
              ),
            ]),
          ])
        );
      }
      playerTableContainer.appendChild(
        el("table", {}, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Photo" }),
              el("th", { text: "First name" }),
              el("th", { text: "Last name" }),
              el("th", { text: "#" }),
              el("th", { text: "Height" }),
              el("th", { text: "Year" }),
              el("th", { text: "" }),
            ]),
          ]),
          tbody,
        ])
      );
    }

    function renderPlayerForm() {
      playerFormContainer.innerHTML = "";
      const firstNameInput = el("input", { placeholder: "First name", value: editingPlayer?.first_name || "" });
      const lastNameInput = el("input", { placeholder: "Last name", value: editingPlayer?.last_name || "" });
      const numberInput = el("input", { placeholder: "#", value: editingPlayer?.number || "" });
      const heightInput = el("input", { placeholder: "Height", value: editingPlayer?.height || "" });
      const yearSelect = buildYearSelect(editingPlayer?.year);
      const profileInput = el("textarea", { placeholder: "Profile", rows: "4" });
      profileInput.value = editingPlayer?.profile || "";
      const imageField = createImageField(editingPlayer?.image || "");

      const form = el("form", { class: "item-form" }, [
        el("label", { text: "First name" }, [firstNameInput]),
        el("label", { text: "Last name" }, [lastNameInput]),
        el("label", { text: "#" }, [numberInput]),
        el("label", { text: "Height" }, [heightInput]),
        el("label", { text: "Year" }, [yearSelect]),
        el("label", { text: "Profile" }, [profileInput]),
        el("div", { class: "photo-field-group" }, [el("span", { text: "Photo" }), imageField.element]),
        el("button", { type: "submit", text: editingPlayer ? "Save" : "Create" }),
        ...(editingPlayer
          ? [
              el("button", { type: "button", text: "Cancel" }).also((btn) =>
                btn.addEventListener("click", () => {
                  editingPlayer = null;
                  renderPlayerForm();
                })
              ),
            ]
          : []),
      ]);

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (imageField.hasPendingCrop()) {
          try {
            await imageField.commitPendingCrop();
          } catch (err) {
            return;
          }
        }

        const values = {
          first_name: firstNameInput.value,
          last_name: lastNameInput.value,
          number: numberInput.value,
          height: heightInput.value,
          year: yearSelect.value,
          profile: profileInput.value,
          image: imageField.getValue(),
        };
        const path = editingPlayer
          ? `/players/${encodeURIComponent(selectedTeam.team_id)}/${encodeURIComponent(editingPlayer.player_id)}`
          : `/players/${encodeURIComponent(selectedTeam.team_id)}`;
        await apiFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        editingPlayer = null;
        renderPlayerForm();
        refreshPlayers();
      });

      playerFormContainer.appendChild(form);
    }

    renderPlayerForm();
    await refreshPlayers();
  }

  await renderTeamForm();
  await refreshTeams();
}

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

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

async function renderScheduleSection(container) {
  container.innerHTML = "";

  const partitionInput = el("input", { placeholder: "Season", value: defaultSeason() });
  const loadButton = el("button", { type: "button", text: "Load" });
  container.appendChild(el("div", { class: "partition-row" }, [partitionInput, loadButton]));

  const formContainer = el("div", { class: "form-container" });
  const tableContainer = el("div", { class: "table-container" });
  container.appendChild(formContainer);
  container.appendChild(tableContainer);

  let editing = null;
  let viewYear = null;
  let viewMonth = null; // 0-indexed

  function buildCalendar(games, teamsById, teams) {
    tableContainer.innerHTML = "";

    const gamesByDate = {};
    for (const game of games) {
      if (!game.date) continue;
      (gamesByDate[game.date] ||= []).push(game);
    }

    const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleString(undefined, {
      month: "long",
      year: "numeric",
    });
    const prevBtn = el("button", { type: "button", text: "◀" }).also((btn) =>
      btn.addEventListener("click", () => {
        viewMonth -= 1;
        if (viewMonth < 0) {
          viewMonth = 11;
          viewYear -= 1;
        }
        buildCalendar(games, teamsById, teams);
      })
    );
    const nextBtn = el("button", { type: "button", text: "▶" }).also((btn) =>
      btn.addEventListener("click", () => {
        viewMonth += 1;
        if (viewMonth > 11) {
          viewMonth = 0;
          viewYear += 1;
        }
        buildCalendar(games, teamsById, teams);
      })
    );

    const grid = el("div", { class: "calendar-grid" });
    for (const dow of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      grid.appendChild(el("div", { class: "calendar-dow", text: dow }));
    }

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    for (let i = 0; i < firstOfMonth.getDay(); i++) {
      grid.appendChild(el("div", { class: "calendar-cell calendar-cell-empty" }));
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const cell = el("div", { class: "calendar-cell" }, [el("div", { class: "calendar-day-number", text: String(day) })]);

      for (const game of gamesByDate[iso] || []) {
        const teamName = teamsById[game.team_id]?.name;
        const label = [game.time, game.home_away === "Home" ? "vs" : "at", game.opponent, teamName && `(${teamName})`]
          .filter(Boolean)
          .join(" ");
        cell.appendChild(
          el("div", { class: "calendar-event", text: label }).also((chip) =>
            chip.addEventListener("click", () => {
              editing = game;
              renderForm(teams);
              formContainer.scrollIntoView({ behavior: "smooth", block: "start" });
            })
          )
        );
      }
      grid.appendChild(cell);
    }

    tableContainer.appendChild(el("div", { class: "calendar-header" }, [prevBtn, el("h2", { text: monthLabel }), nextBtn]));
    tableContainer.appendChild(grid);
  }

  async function refresh() {
    const season = partitionInput.value.trim();
    if (!season) return;
    const [games, teams] = await Promise.all([apiFetch(`/schedule/${encodeURIComponent(season)}`), apiFetch("/rosters")]);
    const teamsById = Object.fromEntries(teams.map((t) => [t.team_id, t]));

    if (viewYear === null) {
      const earliestDate = games.reduce((min, g) => (g.date && (!min || g.date < min) ? g.date : min), null);
      const [y, m] = (earliestDate || isoDate(new Date())).split("-").map(Number);
      viewYear = y;
      viewMonth = m - 1;
    }

    buildCalendar(games, teamsById, teams);
  }

  function renderForm(teams) {
    const season = partitionInput.value.trim();
    formContainer.innerHTML = "";
    if (!season) return;

    const dateInput = el("input", { type: "date", value: editing?.date || "" });
    const timeInput = el("input", { placeholder: "Time (e.g. 7:00 PM or TBA)", value: editing?.time || "" });
    const opponentInput = el("input", { placeholder: "Opponent", value: editing?.opponent || "" });
    const homeAwaySelect = el("select", {}, [
      el("option", { value: "Home", text: "Home" }),
      el("option", { value: "Away", text: "Away" }),
    ]);
    homeAwaySelect.value = editing?.home_away || "Home";
    const addressInput = el("input", { placeholder: "Address (for Google Maps)", value: editing?.address || "" });
    const teamSelect = el("select", {}, [
      el("option", { value: "", text: "(none)" }),
      ...teams.map((t) => el("option", { value: t.team_id, text: t.name || "" })),
    ]);
    teamSelect.value = editing?.team_id || "";
    const ourScoreInput = el("input", { placeholder: "Our score", value: editing?.our_score || "" });
    const opponentScoreInput = el("input", { placeholder: "Opponent score", value: editing?.opponent_score || "" });

    const form = el("form", { class: "item-form" }, [
      el("label", { text: "Date" }, [dateInput]),
      el("label", { text: "Time" }, [timeInput]),
      el("label", { text: "Opponent" }, [opponentInput]),
      el("label", { text: "Home/Away" }, [homeAwaySelect]),
      el("label", { text: "Address" }, [addressInput]),
      el("label", { text: "Team" }, [teamSelect]),
      el("label", { text: "Our score" }, [ourScoreInput]),
      el("label", { text: "Opponent score" }, [opponentScoreInput]),
      el("button", { type: "submit", text: editing ? "Save" : "Create" }),
      ...(editing
        ? [
            el("button", { type: "button", text: "Delete" }).also((btn) =>
              btn.addEventListener("click", async () => {
                await apiFetch(`/schedule/${encodeURIComponent(season)}/${encodeURIComponent(editing.game_id)}`, {
                  method: "DELETE",
                });
                editing = null;
                renderForm(teams);
                refresh();
              })
            ),
            el("button", { type: "button", text: "Cancel" }).also((btn) =>
              btn.addEventListener("click", () => {
                editing = null;
                renderForm(teams);
              })
            ),
          ]
        : []),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const values = {
        date: dateInput.value,
        time: timeInput.value,
        opponent: opponentInput.value,
        home_away: homeAwaySelect.value,
        address: addressInput.value,
        team_id: teamSelect.value,
        our_score: ourScoreInput.value,
        opponent_score: opponentScoreInput.value,
      };
      const path = editing
        ? `/schedule/${encodeURIComponent(season)}/${encodeURIComponent(editing.game_id)}`
        : `/schedule/${encodeURIComponent(season)}`;
      await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      editing = null;
      renderForm(teams);
      refresh();
    });

    formContainer.appendChild(form);
  }

  loadButton.addEventListener("click", async () => {
    editing = null;
    viewYear = null; // recenter the calendar on the newly loaded season
    const teams = await apiFetch("/rosters");
    renderForm(teams);
    refresh();
  });

  const teams = await apiFetch("/rosters");
  renderForm(teams);
  await refresh();
}

async function renderNewsSection(container) {
  container.innerHTML = "";
  const formContainer = el("div", { class: "form-container" });
  const tableContainer = el("div", { class: "table-container" });
  container.appendChild(formContainer);
  container.appendChild(tableContainer);

  let editing = null;
  const today = isoDate(new Date());
  const earliestPublishDate = addDays(today, 1); // "future" = strictly after today

  async function refresh() {
    const items = await apiFetch("/news");
    tableContainer.innerHTML = "";
    const tbody = el("tbody");
    for (const item of items) {
      const photoCell = el("td");
      if (item.image) photoCell.appendChild(el("img", { src: item.image, class: "thumb" }));

      tbody.appendChild(
        el("tr", {}, [
          photoCell,
          el("td", { text: item.title || "" }),
          el("td", { text: item.published_date || "" }),
          el("td", { text: item.end_date || "" }),
          el("td", {}, [
            el("button", { type: "button", text: "Edit" }).also((btn) =>
              btn.addEventListener("click", () => {
                editing = item;
                renderForm();
              })
            ),
            el("button", { type: "button", text: "Delete" }).also((btn) =>
              btn.addEventListener("click", async () => {
                await apiFetch(`/news/${encodeURIComponent(item.post_id)}`, { method: "DELETE" });
                refresh();
              })
            ),
          ]),
        ])
      );
    }
    tableContainer.appendChild(
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "Photo" }),
            el("th", { text: "Title" }),
            el("th", { text: "Published date" }),
            el("th", { text: "End date" }),
            el("th", { text: "" }),
          ]),
        ]),
        tbody,
      ])
    );
  }

  function renderForm() {
    formContainer.innerHTML = "";

    const titleInput = el("input", { placeholder: "Title", value: editing?.title || "" });
    const bodyInput = el("textarea", { placeholder: "Body", rows: "4" });
    bodyInput.value = editing?.body || "";
    const publishedInput = el("input", { type: "date", min: earliestPublishDate, value: editing?.published_date || "" });
    const endInput = el("input", {
      type: "date",
      min: addDays(publishedInput.value || earliestPublishDate, 1),
      value: editing?.end_date || "",
    });
    const imageField = createImageField(editing?.image || "");
    const errorEl = el("p", { class: "field-error" });
    errorEl.hidden = true;

    // End date must always be after whatever Published date currently holds.
    publishedInput.addEventListener("change", () => {
      endInput.min = addDays(publishedInput.value || earliestPublishDate, 1);
      if (endInput.value && endInput.value <= publishedInput.value) endInput.value = "";
    });

    const form = el("form", { class: "item-form" }, [
      el("label", { text: "Title" }, [titleInput]),
      el("label", { text: "Body" }, [bodyInput]),
      el("label", { text: "Published date" }, [publishedInput]),
      el("label", { text: "End date" }, [endInput]),
      el("div", { class: "photo-field-group" }, [el("span", { text: "Photo" }), imageField.element]),
      el("button", { type: "submit", text: editing ? "Save" : "Create" }),
      ...(editing
        ? [
            el("button", { type: "button", text: "Cancel" }).also((btn) =>
              btn.addEventListener("click", () => {
                editing = null;
                renderForm();
              })
            ),
          ]
        : []),
      errorEl,
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;

      if (publishedInput.value && publishedInput.value <= today) {
        errorEl.textContent = "Published date must be in the future.";
        errorEl.hidden = false;
        return;
      }
      if (endInput.value && publishedInput.value && endInput.value <= publishedInput.value) {
        errorEl.textContent = "End date must be after the published date.";
        errorEl.hidden = false;
        return;
      }
      if (imageField.hasPendingCrop()) {
        try {
          await imageField.commitPendingCrop();
        } catch (err) {
          return;
        }
      }

      const values = {
        title: titleInput.value,
        body: bodyInput.value,
        published_date: publishedInput.value,
        end_date: endInput.value,
        image: imageField.getValue(),
      };
      const path = editing ? `/news/${encodeURIComponent(editing.post_id)}` : "/news";
      await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      editing = null;
      renderForm();
      refresh();
    });

    formContainer.appendChild(form);
  }

  renderForm();
  await refresh();
}

async function renderContentBlocksSection(container) {
  container.innerHTML = "";
  const formContainer = el("div", { class: "form-container" });
  const tableContainer = el("div", { class: "table-container" });
  container.appendChild(formContainer);
  container.appendChild(tableContainer);

  let editing = null;
  let draggedId = null;

  async function persistOrder(items) {
    const updated = items.map((item, index) => ({ ...item, order: index }));
    await Promise.all(
      updated.map((item) =>
        apiFetch(`/content-blocks/${encodeURIComponent(item.block_id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      )
    );
  }

  function renderTable(items) {
    tableContainer.innerHTML = "";
    const tbody = el("tbody");
    for (const item of items) {
      const photoCell = el("td");
      if (item.image) photoCell.appendChild(el("img", { src: item.image, class: "thumb" }));

      const row = el("tr", { draggable: "true", class: "draggable-row" }, [
        el("td", { class: "drag-handle", text: "☰" }),
        photoCell,
        el("td", { text: item.title || "" }),
        el("td", { text: item.body || "" }),
        el("td", { text: item.special ? "Yes" : "" }),
        el("td", { text: item.generator || "" }),
        el("td", {}, [
          el("button", { type: "button", text: "Edit" }).also((btn) =>
            btn.addEventListener("click", () => {
              editing = item;
              renderForm();
            })
          ),
          el("button", { type: "button", text: "Delete" }).also((btn) =>
            btn.addEventListener("click", async () => {
              await apiFetch(`/content-blocks/${encodeURIComponent(item.block_id)}`, { method: "DELETE" });
              refresh();
            })
          ),
        ]),
      ]);

      row.addEventListener("dragstart", (e) => {
        draggedId = item.block_id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.block_id);
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
        if (!draggedId || draggedId === item.block_id) return;
        const fromIndex = items.findIndex((i) => i.block_id === draggedId);
        const toIndex = items.findIndex((i) => i.block_id === item.block_id);
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        renderTable(items);
        persistOrder(items).catch(() => refresh());
      });

      tbody.appendChild(row);
    }
    tableContainer.appendChild(
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "" }),
            el("th", { text: "Photo" }),
            el("th", { text: "Title" }),
            el("th", { text: "Body" }),
            el("th", { text: "NoIndex" }),
            el("th", { text: "Generator" }),
            el("th", { text: "" }),
          ]),
        ]),
        tbody,
      ])
    );
  }

  async function refresh() {
    const items = await apiFetch("/content-blocks");
    renderTable(items);
  }

  function renderForm() {
    formContainer.innerHTML = "";

    const titleInput = el("input", { placeholder: "Title", value: editing?.title || "" });
    const bodyInput = el("textarea", { placeholder: "Body", rows: "4" });
    bodyInput.value = editing?.body || "";
    const imageField = createImageField(editing?.image || "");
    const specialCheckbox = el("input", { type: "checkbox" });
    specialCheckbox.checked = !!editing?.special;
    const generatorSelect = buildGeneratorSelect(editing?.generator);

    const form = el("form", { class: "item-form" }, [
      el("label", { text: "Title" }, [titleInput]),
      el("label", { text: "Body" }, [bodyInput]),
      el("div", { class: "photo-field-group" }, [el("span", { text: "Photo" }), imageField.element]),
      el("label", { class: "checkbox-label" }, [
        specialCheckbox,
        el("span", { text: "NoIndex" }),
      ]),
      el("label", { text: "Generator" }, [generatorSelect]),
      el("button", { type: "submit", text: editing ? "Save" : "Create" }),
      ...(editing
        ? [
            el("button", { type: "button", text: "Cancel" }).also((btn) =>
              btn.addEventListener("click", () => {
                editing = null;
                renderForm();
              })
            ),
          ]
        : []),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (imageField.hasPendingCrop()) {
        try {
          await imageField.commitPendingCrop();
        } catch (err) {
          return;
        }
      }

      const values = {
        title: titleInput.value,
        body: bodyInput.value,
        image: imageField.getValue(),
        special: specialCheckbox.checked,
        generator: generatorSelect.value,
      };
      const path = editing ? `/content-blocks/${encodeURIComponent(editing.block_id)}` : "/content-blocks";
      await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      editing = null;
      renderForm();
      refresh();
    });

    formContainer.appendChild(form);
  }

  renderForm();
  await refresh();
}

// A Content Block with a Generator set drives one of the public site's
// dynamic pages (see frontend/site.js's GENERATOR_PAGES) instead of just
// being a text section - e.g. the "Coaches" block's body becomes the
// coaches.html intro, and its title becomes both the page <h1> and the
// sidebar nav label there.
const CONTENT_BLOCK_GENERATORS = ["", "Coaches", "Rosters", "Schedule", "News", "Contact Us"];

function buildGeneratorSelect(selected) {
  const select = el(
    "select",
    {},
    CONTENT_BLOCK_GENERATORS.map((g) => el("option", { value: g, text: g || "None" }))
  );
  select.value = selected || "";
  return select;
}

const CONTACT_TYPES = ["Email", "Physical Address", "Instagram"];

function buildContactTypeSelect(selected) {
  const select = el("select", {}, CONTACT_TYPES.map((t) => el("option", { value: t, text: t })));
  select.value = selected || CONTACT_TYPES[0];
  return select;
}

async function renderContactsSection(container) {
  container.innerHTML = "";
  const formContainer = el("div", { class: "form-container" });
  const tableContainer = el("div", { class: "table-container" });
  container.appendChild(formContainer);
  container.appendChild(tableContainer);

  let editing = null;
  let draggedId = null;

  async function persistOrder(items) {
    const updated = items.map((item, index) => ({ ...item, order: index }));
    await Promise.all(
      updated.map((item) =>
        apiFetch(`/contacts/${encodeURIComponent(item.contact_id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      )
    );
  }

  function renderTable(items) {
    tableContainer.innerHTML = "";
    const tbody = el("tbody");
    for (const item of items) {
      const row = el("tr", { draggable: "true", class: "draggable-row" }, [
        el("td", { class: "drag-handle", text: "☰" }),
        el("td", { text: item.label || "" }),
        el("td", { text: item.type || "" }),
        el("td", { text: item.value || "" }),
        el("td", {}, [
          el("button", { type: "button", text: "Edit" }).also((btn) =>
            btn.addEventListener("click", () => {
              editing = item;
              renderForm();
            })
          ),
          el("button", { type: "button", text: "Delete" }).also((btn) =>
            btn.addEventListener("click", async () => {
              await apiFetch(`/contacts/${encodeURIComponent(item.contact_id)}`, { method: "DELETE" });
              refresh();
            })
          ),
        ]),
      ]);

      row.addEventListener("dragstart", (e) => {
        draggedId = item.contact_id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.contact_id);
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
        if (!draggedId || draggedId === item.contact_id) return;
        const fromIndex = items.findIndex((i) => i.contact_id === draggedId);
        const toIndex = items.findIndex((i) => i.contact_id === item.contact_id);
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        renderTable(items);
        persistOrder(items).catch(() => refresh());
      });

      tbody.appendChild(row);
    }
    tableContainer.appendChild(
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "" }),
            el("th", { text: "Label" }),
            el("th", { text: "Type" }),
            el("th", { text: "Value" }),
            el("th", { text: "" }),
          ]),
        ]),
        tbody,
      ])
    );
  }

  async function refresh() {
    const items = await apiFetch("/contacts");
    renderTable(items);
  }

  function renderForm() {
    formContainer.innerHTML = "";

    const labelInput = el("input", { placeholder: "Label (e.g. General Info)", value: editing?.label || "" });
    const typeSelect = buildContactTypeSelect(editing?.type);
    const valueInput = el("textarea", { placeholder: "Value", rows: "2" });
    valueInput.value = editing?.value || "";

    const form = el("form", { class: "item-form" }, [
      el("label", { text: "Label" }, [labelInput]),
      el("label", { text: "Type" }, [typeSelect]),
      el("label", { text: "Value" }, [valueInput]),
      el("button", { type: "submit", text: editing ? "Save" : "Create" }),
      ...(editing
        ? [
            el("button", { type: "button", text: "Cancel" }).also((btn) =>
              btn.addEventListener("click", () => {
                editing = null;
                renderForm();
              })
            ),
          ]
        : []),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const values = {
        label: labelInput.value,
        type: typeSelect.value,
        value: valueInput.value,
      };
      const path = editing ? `/contacts/${encodeURIComponent(editing.contact_id)}` : "/contacts";
      await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      editing = null;
      renderForm();
      refresh();
    });

    formContainer.appendChild(form);
  }

  renderForm();
  await refresh();
}

const SECTIONS = {
  "content-blocks": (container) => renderContentBlocksSection(container),
  news: (container) => renderNewsSection(container),
  rosters: (container) => renderRostersSection(container),
  schedule: (container) => renderScheduleSection(container),
  coaches: (container) => renderCoachesSection(container),
  contacts: (container) => renderContactsSection(container),
};

function initDashboard() {
  const tabs = document.querySelectorAll("[data-tab]");
  const container = document.getElementById("section-container");

  function activate(tabName) {
    for (const tab of tabs) tab.classList.toggle("active", tab.dataset.tab === tabName);
    SECTIONS[tabName](container);
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab.dataset.tab));
  }

  activate("content-blocks");
}
