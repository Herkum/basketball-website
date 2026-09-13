async function siteFetch(path) {
  const response = await fetch(`${window.SITE_CONFIG.apiBase}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// A few Content Blocks (Home / Mission Statement / Sponsors) are plain text
// sections with no dedicated page or Generator - look those up by title.
function findBlock(blocks, title) {
  return blocks.find((b) => (b.title || "").toLowerCase() === title.toLowerCase());
}

// Content Blocks with a Generator drive a dedicated public page (see
// CLAUDE.md) - look one up by its Generator value instead of its title, so
// the admin can rename the block freely without breaking the link.
function findBlockByGenerator(blocks, generator) {
  return blocks.find((b) => b.generator === generator);
}

const GENERATOR_PAGES = {
  Coaches: "coaches.html",
  Rosters: "rosters.html",
  Schedule: "schedule.html",
  News: "news.html",
  "Contact Us": "contact.html",
};

function pageForGenerator(generator) {
  return GENERATOR_PAGES[generator] || "index.html";
}

// Builds the sidebar (one link per non-NoIndex Content Block, in `order`)
// and fills the header bar from the NoIndex "Header" block's body. Returns
// the fetched blocks so callers can look up their own page's block.
async function initLayout() {
  const currentFile = window.location.pathname.split("/").pop() || "index.html";
  const currentTeamId = new URLSearchParams(window.location.search).get("team");

  let blocks = [];
  try {
    blocks = await siteFetch("/content-blocks");
  } catch (err) {
    // fall back to an empty sidebar/header below
  }
  const teams = await siteFetch("/rosters").catch(() => []);

  const headerBlock = blocks.find((b) => b.special);
  const siteName = headerBlock?.body || "Basketball";

  const header = document.getElementById("site-header");
  header.appendChild(
    el("header", { class: "site-header" }, [
      el("a", { href: "index.html", class: "site-title", text: siteName }),
    ])
  );

  const navLinks = blocks
    .filter((b) => !b.special)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const navItems = [];
  for (const block of navLinks) {
    const href = pageForGenerator(block.generator || "");
    // Blocks with no Generator (Home/Mission Statement/Sponsors) all fall
    // back to index.html - only the Home block itself should show as
    // active there, not every text section that happens to live on it.
    const isRosters = block.generator === "Rosters";
    const isActive = block.generator
      ? href === currentFile || (isRosters && currentFile === "roster.html")
      : (block.title || "").toLowerCase() === "home" && currentFile === "index.html";
    navItems.push(
      el("a", {
        href,
        text: block.title || "",
        ...(isActive ? { class: "active" } : {}),
      })
    );

    if (isRosters) {
      for (const team of teams) {
        navItems.push(
          el("a", {
            href: `roster.html?team=${encodeURIComponent(team.team_id)}`,
            text: team.name || "",
            class: currentFile === "roster.html" && currentTeamId === team.team_id ? "sub-link active" : "sub-link",
          })
        );
      }
    }
  }

  const sidebar = document.getElementById("site-sidebar");
  sidebar.appendChild(el("nav", { class: "site-nav" }, navItems));

  return blocks;
}

function setPageTitle(title) {
  const heading = document.getElementById("page-title");
  if (heading) heading.textContent = title || "";
}

async function initHomePage() {
  const blocks = await initLayout();
  setPageTitle("Welcome");
  const main = document.getElementById("page-content");

  const [rosters, news] = await Promise.all([siteFetch("/rosters"), siteFetch("/news")]);

  const homeBlock = findBlock(blocks, "Home");
  const mission = findBlock(blocks, "Mission Statement");
  const sponsors = findBlock(blocks, "Sponsors");

  if (homeBlock?.body) main.appendChild(el("p", { class: "page-intro", text: homeBlock.body }));
  if (mission?.body) {
    main.appendChild(el("h2", { text: "Mission Statement" }));
    main.appendChild(el("p", { text: mission.body }));
  }
  if (sponsors?.body) {
    main.appendChild(el("h2", { text: "Sponsors" }));
    main.appendChild(el("p", { text: sponsors.body }));
  }

  const today = isoDate(new Date());
  const activeNews = news
    .filter((n) => n.published_date && n.published_date <= today && (!n.end_date || n.end_date >= today))
    .sort((a, b) => (b.published_date || "").localeCompare(a.published_date || ""));

  const allGames = await siteFetch(`/schedule/${defaultSeason()}`).catch(() => []);
  const upcoming = allGames
    .filter((g) => g.date && g.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const teamsById = Object.fromEntries(rosters.map((t) => [t.team_id, t]));

  const teaserGrid = el("div", { class: "teaser-grid" });
  if (upcoming) {
    teaserGrid.appendChild(
      el("div", { class: "teaser-card" }, [
        el("h3", { text: "Next Game" }),
        el("p", {
          text: `${upcoming.date}${upcoming.time ? " · " + upcoming.time : ""} — ${
            upcoming.home_away === "Home" ? "vs" : "at"
          } ${upcoming.opponent || ""}${teamsById[upcoming.team_id] ? " (" + teamsById[upcoming.team_id].name + ")" : ""}`,
        }),
        el("a", { href: "schedule.html", text: "Full schedule →" }),
      ])
    );
  }
  if (activeNews[0]) {
    teaserGrid.appendChild(
      el("div", { class: "teaser-card" }, [
        el("h3", { text: "Latest News" }),
        el("p", { text: activeNews[0].title || "" }),
        el("a", { href: "news.html", text: "Read more →" }),
      ])
    );
  }
  if (teaserGrid.children.length) main.appendChild(teaserGrid);
}

function defaultSeason() {
  const now = new Date();
  const year = now.getFullYear();
  return now.getMonth() >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

async function initRostersPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Rosters");
  setPageTitle(intro?.title || "Rosters");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const teams = await siteFetch("/rosters");
  if (!teams.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No teams yet." }));
    return;
  }

  const grid = el("div", { class: "card-grid" });
  for (const team of teams) {
    const card = el("a", { href: `roster.html?team=${encodeURIComponent(team.team_id)}`, class: "card" }, [
      el("img", { class: "card-photo", src: team.image || "", alt: team.name || "" }),
      el("div", { class: "card-body" }, [el("p", { class: "card-title", text: team.name || "" })]),
    ]);
    grid.appendChild(card);
  }
  main.appendChild(grid);
}

async function initRosterDetailPage() {
  await initLayout();
  const main = document.getElementById("page-content");
  const teamId = new URLSearchParams(window.location.search).get("team");

  if (!teamId) {
    setPageTitle("Roster");
    main.appendChild(el("p", { class: "empty-state", text: "No team specified." }));
    return;
  }

  const [team, players, coaches] = await Promise.all([
    siteFetch(`/rosters/${encodeURIComponent(teamId)}`),
    siteFetch(`/players/${encodeURIComponent(teamId)}`),
    siteFetch("/coaches"),
  ]);
  const coachesById = Object.fromEntries(coaches.map((c) => [c.coach_id, c]));
  const coachNames = (team.coach_ids || []).map((id) => coachesById[id]?.name).filter(Boolean).join(", ");

  document.title = team.name ? `${team.name} Roster` : "Roster";
  setPageTitle(team.name || "Roster");

  if (team.image) main.appendChild(el("img", { class: "card-photo", src: team.image, alt: team.name || "" }));
  if (coachNames) main.appendChild(el("p", { class: "card-subtitle", text: `Coaches: ${coachNames}` }));

  if (!players.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No players listed yet." }));
    return;
  }

  const tbody = el("tbody");
  for (const p of players) {
    const photoCell = el("td");
    if (p.image) photoCell.appendChild(el("img", { src: p.image, alt: "", style: "width:40px;height:40px;object-fit:cover;border-radius:6px" }));
    tbody.appendChild(
      el("tr", {}, [
        photoCell,
        el("td", { text: p.first_name || "" }),
        el("td", { text: p.last_name || "" }),
        el("td", { text: p.number || "" }),
        el("td", { text: p.height || "" }),
        el("td", { text: p.year || "" }),
      ])
    );
  }

  main.appendChild(
    el("table", {}, [
      el("thead", {}, [
        el(
          "tr",
          {},
          ["", "First name", "Last name", "#", "Height", "Year"].map((t) => el("th", { text: t }))
        ),
      ]),
      tbody,
    ])
  );
}

async function initSchedulePage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Schedule");
  setPageTitle(intro?.title || "Schedule");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const [teams, games] = await Promise.all([
    siteFetch("/rosters"),
    siteFetch(`/schedule/${defaultSeason()}`),
  ]);

  const teamsById = Object.fromEntries(teams.map((t) => [t.team_id, t]));
  const sorted = [...games].sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const filterRow = el("div", { class: "filter-row" });
  const tableContainer = el("div");
  main.appendChild(filterRow);
  main.appendChild(tableContainer);

  function renderTable(filterTeamId) {
    tableContainer.innerHTML = "";
    const filtered = filterTeamId ? sorted.filter((g) => g.team_id === filterTeamId) : sorted;

    if (!filtered.length) {
      tableContainer.appendChild(el("p", { class: "empty-state", text: "No games scheduled." }));
      return;
    }

    const tbody = el("tbody");
    for (const g of filtered) {
      const addressCell = el("td");
      if (g.address) addressCell.appendChild(el("a", { href: mapsUrl(g.address), target: "_blank", class: "maps-link", text: "Map" }));

      tbody.appendChild(
        el("tr", {}, [
          el("td", { text: g.date || "" }),
          el("td", { text: g.time || "" }),
          el("td", { text: teamsById[g.team_id]?.name || "" }),
          el("td", { text: g.home_away === "Home" ? "vs" : "at" }),
          el("td", { text: g.opponent || "" }),
          addressCell,
          el(
            "td",
            {
              text:
                g.our_score || g.opponent_score
                  ? `${g.our_score || "-"} : ${g.opponent_score || "-"}`
                  : "",
            }
          ),
        ])
      );
    }

    tableContainer.appendChild(
      el("table", {}, [
        el(
          "thead",
          {},
          [el("tr", {}, ["Date", "Time", "Team", "", "Opponent", "Location", "Score"].map((t) => el("th", { text: t })))]
        ),
        tbody,
      ])
    );
  }

  const allBtn = el("button", { type: "button", text: "All", class: "active" }).also((btn) =>
    btn.addEventListener("click", () => {
      filterRow.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderTable(null);
    })
  );
  filterRow.appendChild(allBtn);

  for (const team of teams) {
    const btn = el("button", { type: "button", text: team.name || "" }).also((b) =>
      b.addEventListener("click", () => {
        filterRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        renderTable(team.team_id);
      })
    );
    filterRow.appendChild(btn);
  }

  renderTable(null);
}

Element.prototype.also = function (fn) {
  fn(this);
  return this;
};

async function initNewsPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "News");
  setPageTitle(intro?.title || "News");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const news = await siteFetch("/news");
  const today = isoDate(new Date());
  const active = news
    .filter((n) => n.published_date && n.published_date <= today && (!n.end_date || n.end_date >= today))
    .sort((a, b) => (b.published_date || "").localeCompare(a.published_date || ""));

  if (!active.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No news right now." }));
    return;
  }

  for (const post of active) {
    main.appendChild(
      el(
        "article",
        { class: "news-post" },
        [
          post.image ? el("img", { src: post.image, alt: "" }) : null,
          el("div", {}, [
            el("h2", { text: post.title || "" }),
            el("p", { class: "news-post-date", text: post.published_date || "" }),
            el("p", { text: post.body || "" }),
          ]),
        ].filter(Boolean)
      )
    );
  }
}

async function initCoachesPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Coaches");
  setPageTitle(intro?.title || "Coaches");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const coaches = await siteFetch("/coaches");
  if (!coaches.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No coaches listed yet." }));
    return;
  }

  for (const coach of coaches) {
    main.appendChild(
      el(
        "div",
        { class: "coach-row" },
        [
          coach.image ? el("img", { src: coach.image, alt: coach.name || "" }) : null,
          el("div", {}, [
            el("h2", { text: coach.name || "" }),
            el("p", { class: "card-subtitle", text: coach.title || "" }),
            coach.profile ? el("p", { text: coach.profile }) : null,
          ]),
        ].filter(Boolean)
      )
    );
  }
}

async function initContactPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Contact Us");
  setPageTitle(intro?.title || "Contact Us");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const contacts = await siteFetch("/contacts");
  if (!contacts.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No contact info yet." }));
    return;
  }

  for (const contact of contacts) {
    let valueNode;
    if (contact.type === "Email") {
      valueNode = el("a", { href: `mailto:${contact.value}`, text: contact.value || "" });
    } else if (contact.type === "Physical Address") {
      valueNode = el("a", { href: mapsUrl(contact.value || ""), target: "_blank", text: contact.value || "" });
    } else if (contact.type === "Instagram") {
      const handle = (contact.value || "").replace(/^@/, "");
      valueNode = el("a", { href: `https://instagram.com/${handle}`, target: "_blank", text: contact.value || "" });
    } else {
      valueNode = el("span", { text: contact.value || "" });
    }

    main.appendChild(
      el("div", { class: "contact-row" }, [
        el("div", {}, [
          el("h2", { text: contact.label || contact.type || "" }),
          el("p", { class: "card-subtitle", text: contact.type || "" }),
          valueNode,
        ]),
      ])
    );
  }
}
