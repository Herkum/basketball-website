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

// mapsUrl/isoDate/defaultSeason live in shared.js (loaded before this file).

// Ordinary News only shows within its published_date..end_date window.
// Events are upcoming items meant to be visible as soon as they're
// announced (their Published date can be today, unlike News), so they
// skip the published_date gate entirely and stay visible until end_date.
function isNewsActive(n, today) {
  if (n.is_event) return !n.end_date || n.end_date >= today;
  return Boolean(n.published_date) && n.published_date <= today && (!n.end_date || n.end_date >= today);
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
  Sponsors: "sponsors.html",
  Photos: "photos.html",
  Standings: "standings.html",
  "Mission Statement": "mission.html",
};

function pageForGenerator(generator) {
  return GENERATOR_PAGES[generator] || "index.html";
}

// Standings rows store records as "W-L" strings (from the MaxPreps
// scrape) - parse one back into numbers for sorting/comparison.
function parseRecord(str) {
  const [wins, losses] = (str || "0-0").split("-").map(Number);
  return { wins: wins || 0, losses: losses || 0 };
}

// Best league record first, then best overall record as a tiebreaker -
// used instead of the scraped `rank` field, which this site doesn't show.
function compareStandingsRows(a, b) {
  const aLeague = parseRecord(a.league_record);
  const bLeague = parseRecord(b.league_record);
  if (aLeague.wins !== bLeague.wins) return bLeague.wins - aLeague.wins;
  if (aLeague.losses !== bLeague.losses) return aLeague.losses - bLeague.losses;
  const aOverall = parseRecord(a.overall_record);
  const bOverall = parseRecord(b.overall_record);
  if (aOverall.wins !== bOverall.wins) return bOverall.wins - aOverall.wins;
  return aOverall.losses - bOverall.losses;
}

// Builds the sidebar (brand block, W-L record box, one nav link per
// non-NoIndex Content Block in `order`, and an address/league footer) and
// fills the header bar from the "Header" block's body. Returns the fetched
// blocks so callers can look up their own page's block.
// Click-to-enlarge for every real photo on the site (team/coach/news/
// gallery images all carry the .plate class - see CLAUDE.md). Delegated
// on document so it works for images rendered after this runs, and
// scoped to "img.plate" specifically so the gym-photo-placeholder div
// (also .plate-styled, but not a real image) isn't clickable. Set up
// once from initLayout(), which every page calls before rendering its
// own content.
let lightboxInitialized = false;
function initImageLightbox() {
  if (lightboxInitialized) return;
  lightboxInitialized = true;

  const backdrop = el("div", { class: "lightbox-backdrop" });
  const img = el("img", { class: "lightbox-img" });
  const closeBtn = el("button", { type: "button", class: "lightbox-close", text: "×", "aria-label": "Close" });
  backdrop.appendChild(img);
  backdrop.appendChild(closeBtn);
  backdrop.hidden = true;
  document.body.appendChild(backdrop);

  function close() {
    backdrop.hidden = true;
    img.src = "";
  }
  function open(src, alt) {
    img.src = src;
    img.alt = alt || "";
    backdrop.hidden = false;
  }

  document.addEventListener("click", (e) => {
    const target = e.target.closest("img.plate");
    if (target) open(target.src, target.alt);
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target === closeBtn) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !backdrop.hidden) close();
  });
}

async function initLayout() {
  initImageLightbox();
  const currentFile = window.location.pathname.split("/").pop() || "index.html";
  const currentTeamId = new URLSearchParams(window.location.search).get("team");

  let blocks = [];
  try {
    blocks = await siteFetch("/content-blocks");
  } catch (err) {
    // fall back to an empty sidebar/header below
  }
  const [teams, contacts, standingsCache] = await Promise.all([
    siteFetch("/rosters").catch(() => []),
    siteFetch("/contacts").catch(() => []),
    siteFetch("/standings").catch(() => null),
  ]);

  // Logo is NoIndex (excluded from the nav below) - looked up by generator,
  // same as every other generator-driven block. It still drives the
  // record box's/sidebar footer's/Standings page's "which row is us"
  // matching below, but no longer the header markup itself - the header
  // is static HTML in each page now (see any page's <header
  // class="site-header">), not generated on the fly, since the brand
  // identity essentially never changes. Updating it means editing that
  // HTML directly, not the Logo Content Block.
  const logoBlock = findBlockByGenerator(blocks, "Logo");

  const sidebar = document.getElementById("site-sidebar");

  // The sidebar's record box reads directly off our own row in the
  // scraped Standings cache (matched by school name against the Logo
  // block's title) rather than computing it from Schedule - Standings is
  // already the authoritative source for W-L records site-wide.
  const ourStandingsRow = logoBlock
    ? (standingsCache?.rows || []).find((r) => (r.school || "").toLowerCase() === (logoBlock.title || "").toLowerCase())
    : null;
  if (ourStandingsRow) {
    sidebar.appendChild(
      el("div", { class: "record-box" }, [
        el("div", { class: "record-col" }, [
          el("div", { class: "record-value nums", text: ourStandingsRow.overall_record || "" }),
          el("div", { class: "eyebrow", text: "Overall" }),
        ]),
        el("div", { class: "record-col" }, [
          el("div", { class: "record-value nums", text: ourStandingsRow.league_record || "" }),
          el("div", { class: "eyebrow", text: "League" }),
        ]),
      ])
    );
  }

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

  sidebar.appendChild(el("nav", { class: "site-nav" }, navItems));

  // Rendered into #site-footer, a sibling below .layout (not inside the
  // sidebar) - see the .site-footer CSS rule for why that alone puts it
  // at the foot of the page.
  const addressContact = contacts.find((c) => c.type === "Physical Address");
  const footer = document.getElementById("site-footer");
  if (footer && (addressContact || logoBlock?.league_name)) {
    footer.appendChild(
      el(
        "div",
        {},
        [
          addressContact ? el("div", { text: addressContact.value || "" }) : null,
          logoBlock?.league_name ? el("div", { text: logoBlock.league_name }) : null,
        ].filter(Boolean)
      )
    );
  }

  return blocks;
}

function setPageTitle(title) {
  const heading = document.getElementById("page-title");
  if (heading) heading.textContent = title || "";
}

function sectionDivider(title, children) {
  return el("div", { class: "section-divider" }, [
    el("div", { class: "section-heading" }, [el("h2", { text: title })]),
    ...children,
  ]);
}

async function initHomePage() {
  const blocks = await initLayout();
  const homeBlock = findBlock(blocks, "Home");
  const logoBlock = findBlockByGenerator(blocks, "Logo");
  setPageTitle(homeBlock?.title || "Welcome");
  const main = document.getElementById("page-content");
  main.appendChild(el("span", { class: "eyebrow", text: `${defaultSeason()} Season` }));

  const [rosters, news, sponsors, standings, contacts, allGames] = await Promise.all([
    siteFetch("/rosters"),
    siteFetch("/news"),
    siteFetch("/sponsors").catch(() => []),
    siteFetch("/standings").catch(() => null),
    siteFetch("/contacts").catch(() => []),
    siteFetch(`/schedule/${defaultSeason()}`).catch(() => []),
  ]);

  const today = isoDate(new Date());
  const teamsById = Object.fromEntries(rosters.map((t) => [t.team_id, t]));
  const sortedGames = [...allGames].filter((g) => g.date).sort((a, b) => a.date.localeCompare(b.date));
  const played = sortedGames.filter((g) => g.date < today && g.our_score && g.opponent_score);
  const lastResult = played[played.length - 1];
  const upcomingGames = sortedGames.filter((g) => g.date >= today);
  const nextGame = upcomingGames[0];
  const thenGames = upcomingGames.slice(1, 4);
  const gymContact = contacts.find((c) => c.type === "Physical Address");

  function gameLine(g) {
    const teamName = teamsById[g.team_id]?.name;
    return `${g.home_away === "Home" ? "vs" : "at"} ${g.opponent || ""}${teamName ? " (" + teamName + ")" : ""}`;
  }

  const statRow = el("div", { class: "stat-row" });
  if (lastResult) {
    const won = Number(lastResult.our_score) > Number(lastResult.opponent_score);
    statRow.appendChild(
      el("div", { class: "stat-col" }, [
        el("span", { class: "eyebrow", text: "Last Result" }),
        el("div", {
          class: `stat-value nums ${won ? "result-win" : "result-loss"}`,
          text: `${lastResult.our_score} – ${lastResult.opponent_score}`,
        }),
        el("p", { class: "stat-meta", text: `${gameLine(lastResult)} · ${lastResult.date}` }),
      ])
    );
  }
  if (nextGame) {
    const venueLabel =
      nextGame.home_away === "Home"
        ? `Home${gymContact?.label ? " · " + gymContact.label : ""}`
        : `At ${nextGame.location || nextGame.opponent || ""}`;
    statRow.appendChild(
      el("div", { class: "stat-col" }, [
        el("span", { class: "eyebrow", text: "Next Game" }),
        el("div", { class: "stat-value", text: nextGame.opponent || "" }),
        el("p", { class: "stat-meta nums", text: `${nextGame.date}${nextGame.time ? " · " + nextGame.time : ""}` }),
        el("p", { class: "stat-meta", text: venueLabel }),
      ])
    );
  }
  if (thenGames.length) {
    statRow.appendChild(
      el("div", { class: "stat-col" }, [
        el("span", { class: "eyebrow", text: "Then" }),
        ...thenGames.map((g) =>
          el("div", { class: "stat-list-row" }, [el("span", { text: gameLine(g) }), el("span", { class: "nums", text: g.date })])
        ),
        el("a", { href: "schedule.html", text: "Full schedule →" }),
      ])
    );
  }
  if (statRow.children.length) main.appendChild(statRow);

  // Per request: the Home content block's text sits between the stat row
  // and the standings teaser, not at the very top of the page.
  if (homeBlock?.body) main.appendChild(el("p", { class: "page-intro", text: homeBlock.body }));

  const standingsRows = [...(standings?.rows || [])].sort(compareStandingsRows);
  if (standingsRows.length) {
    const tbody = el("tbody");
    for (const row of standingsRows) {
      const isUs = logoBlock && (row.school || "").toLowerCase() === (logoBlock.title || "").toLowerCase();
      const [wins, losses] = (row.league_record || "-").split("-");
      tbody.appendChild(
        el("tr", isUs ? { class: "standings-row-us" } : {}, [
          el("td", { text: row.school || "" }),
          el("td", { class: "nums", text: wins || "" }),
          el("td", { class: "nums", text: losses || "" }),
          el("td", { class: "nums", text: row.league_pf || "" }),
          el("td", { class: "nums", text: row.league_pa || "" }),
          el("td", { class: "nums", text: row.streak || "" }),
        ])
      );
    }
    main.appendChild(
      el("div", { class: "section-divider" }, [
        el("div", { class: "section-heading" }, [
          el("h2", { text: logoBlock?.league_name || "League Standings" }),
          el("span", { class: "eyebrow", text: "Varsity Standings" }),
        ]),
        el("a", { href: "standings.html", text: "Full standings →" }),
        el("table", { style: "margin-top:0.75rem" }, [
          el("thead", {}, [el("tr", {}, ["School", "W", "L", "PF", "PA", "Streak"].map((t) => el("th", { text: t })))]),
          tbody,
        ]),
      ])
    );
  }

  if (sponsors.length) {
    main.appendChild(
      sectionDivider("Sponsors", [el("p", { text: sponsors.map((s) => s.name).filter(Boolean).join(" · ") })])
    );
  }

  // Events (nearest date first) lead over plain news (newest first) -
  // combined into one feed, the first item becomes the lead article
  // (matches the demo's Home news section: a lead story with a photo
  // beside the text, then a grid of smaller cards for the rest).
  const activeEvents = news
    .filter((n) => n.is_event && isNewsActive(n, today))
    .sort((a, b) => (a.published_date || "").localeCompare(b.published_date || ""));
  const activeArticles = news
    .filter((n) => !n.is_event && isNewsActive(n, today))
    .sort((a, b) => (b.published_date || "").localeCompare(a.published_date || ""));
  const feed = [...activeEvents, ...activeArticles];
  const [lead, ...rest] = feed;

  function newsEyebrow(n) {
    return n.is_event ? `Event · ${n.published_date || ""}` : n.published_date || "";
  }

  if (lead) {
    main.appendChild(
      el("div", { class: "section-divider" }, [
        el("div", { class: "section-heading" }, [el("h2", { text: "News" }), el("a", { href: "news.html", text: "Read more →" })]),
        el(
          "article",
          { class: "news-lead" },
          [
            el("div", {}, [
              el("span", { class: "eyebrow", text: newsEyebrow(lead) }),
              el("h3", { text: lead.title || "" }),
              el("p", { class: "rich-text", text: lead.body || "" }),
              el("a", { href: "news.html", text: "Read the recap →" }),
            ]),
            lead.image ? el("img", { class: "plate news-lead-photo", src: lead.image, alt: "" }) : null,
          ].filter(Boolean)
        ),
        rest.length
          ? el(
              "div",
              { class: "news-grid" },
              rest.slice(0, 3).map((n) =>
                el("div", {}, [
                  el("span", { class: "eyebrow", text: newsEyebrow(n) }),
                  el("h4", { text: n.title || "" }),
                  el("p", { class: "card-subtitle", text: n.body || "" }),
                ])
              )
            )
          : null,
      ].filter(Boolean))
    );
  }
}

async function initMissionPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Mission Statement");
  setPageTitle(intro?.title || "Mission Statement");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "rich-text", text: intro.body }));
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
      el("img", { class: "card-photo plate", src: team.image || "", alt: team.name || "" }),
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

  if (team.image) main.appendChild(el("img", { class: "card-photo plate", src: team.image, alt: team.name || "" }));
  if (coachNames) {
    main.appendChild(el("span", { class: "eyebrow", text: "Coaching Staff" }));
    main.appendChild(el("p", { class: "card-subtitle", text: coachNames }));
  }
  if (team.description) main.appendChild(el("p", { class: "rich-text", text: team.description }));

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
        el("td", { class: "nums", text: p.number || "" }),
        el("td", { class: "nums", text: p.height || "" }),
        el("td", { text: p.year || "" }),
      ])
    );
  }

  main.appendChild(
    sectionDivider("Players", [
      el("table", {}, [
        el("thead", {}, [
          el(
            "tr",
            {},
            ["", "First name", "Last name", "#", "Height", "Year"].map((t) => el("th", { text: t }))
          ),
        ]),
        tbody,
      ]),
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
  const viewToggleRow = el("div", { class: "filter-row" });
  const tableContainer = el("div");
  const calendarContainer = el("div");
  main.appendChild(filterRow);
  main.appendChild(viewToggleRow);
  main.appendChild(tableContainer);
  main.appendChild(calendarContainer);

  let currentTeamId = null;
  let view = "list";
  let viewYear = null;
  let viewMonth = null;

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  function monthLabel(dateStr) {
    const [y, m] = (dateStr || "").split("-").map(Number);
    return y && m ? `${MONTH_NAMES[m - 1]} ${y}` : "";
  }

  function renderTable(filterTeamId) {
    tableContainer.innerHTML = "";
    const filtered = filterTeamId ? sorted.filter((g) => g.team_id === filterTeamId) : sorted;

    if (!filtered.length) {
      tableContainer.appendChild(el("p", { class: "empty-state", text: "No games scheduled." }));
      return;
    }

    const groups = [];
    for (const g of filtered) {
      const key = (g.date || "").slice(0, 7);
      if (!groups.length || groups[groups.length - 1].key !== key) {
        groups.push({ key, label: monthLabel(g.date), games: [] });
      }
      groups[groups.length - 1].games.push(g);
    }

    for (const group of groups) {
      const tbody = el("tbody");
      for (const g of group.games) {
        const addressCell = el("td");
        if (g.address) {
          addressCell.appendChild(
            el("a", { href: mapsUrl(g.address), target: "_blank", class: "maps-link", text: g.location || "Map" })
          );
        } else if (g.location) {
          addressCell.appendChild(el("span", { text: g.location }));
        }

        let scoreCell;
        if (g.our_score || g.opponent_score) {
          const won = Number(g.our_score) > Number(g.opponent_score);
          scoreCell = el("td", {
            class: `nums ${won ? "result-win" : "result-loss"}`,
            text: `${g.our_score || "-"} : ${g.opponent_score || "-"}`,
          });
        } else {
          scoreCell = el("td", {});
        }

        tbody.appendChild(
          el("tr", {}, [
            el("td", { class: "nums", text: g.date || "" }),
            el("td", { class: "nums", text: g.time || "" }),
            el("td", { text: teamsById[g.team_id]?.name || "" }),
            el("td", { text: g.home_away === "Home" ? "vs" : "at" }),
            el("td", { text: g.opponent || "" }),
            addressCell,
            scoreCell,
          ])
        );
      }

      const count = group.games.length;
      tableContainer.appendChild(
        sectionDivider(`${group.label} · ${count} game${count === 1 ? "" : "s"}`, [
          el("table", {}, [
            el(
              "thead",
              {},
              [el("tr", {}, ["Date", "Time", "Team", "", "Opponent", "Location", "Score"].map((t) => el("th", { text: t })))]
            ),
            tbody,
          ]),
        ])
      );
    }
  }

  function buildCalendar(filterTeamId) {
    calendarContainer.innerHTML = "";
    const filtered = filterTeamId ? sorted.filter((g) => g.team_id === filterTeamId) : sorted;

    if (viewYear === null) {
      const earliestDate = filtered.reduce((min, g) => (g.date && (!min || g.date < min) ? g.date : min), null);
      const [y, m] = (earliestDate || isoDate(new Date())).split("-").map(Number);
      viewYear = y;
      viewMonth = m - 1;
    }

    const gamesByDate = {};
    for (const g of filtered) {
      if (g.date) (gamesByDate[g.date] ||= []).push(g);
    }

    const label = new Date(viewYear, viewMonth, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
    const prevBtn = el("button", { type: "button", text: "◀" }).also((btn) =>
      btn.addEventListener("click", () => {
        viewMonth -= 1;
        if (viewMonth < 0) {
          viewMonth = 11;
          viewYear -= 1;
        }
        buildCalendar(currentTeamId);
      })
    );
    const nextBtn = el("button", { type: "button", text: "▶" }).also((btn) =>
      btn.addEventListener("click", () => {
        viewMonth += 1;
        if (viewMonth > 11) {
          viewMonth = 0;
          viewYear += 1;
        }
        buildCalendar(currentTeamId);
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

      for (const g of gamesByDate[iso] || []) {
        const teamName = teamsById[g.team_id]?.name;
        const label = [g.time, g.home_away === "Home" ? "vs" : "at", g.opponent, teamName && `(${teamName})`]
          .filter(Boolean)
          .join(" ");
        cell.appendChild(el("div", { class: "calendar-event", text: label }));
      }
      grid.appendChild(cell);
    }

    calendarContainer.appendChild(el("div", { class: "calendar-header" }, [prevBtn, el("h2", { text: label }), nextBtn]));
    calendarContainer.appendChild(grid);
  }

  function renderView() {
    if (view === "list") {
      tableContainer.hidden = false;
      calendarContainer.hidden = true;
      renderTable(currentTeamId);
    } else {
      tableContainer.hidden = true;
      calendarContainer.hidden = false;
      buildCalendar(currentTeamId);
    }
  }

  const listBtn = el("button", { type: "button", text: "List", class: "active" }).also((btn) =>
    btn.addEventListener("click", () => {
      view = "list";
      viewToggleRow.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderView();
    })
  );
  const calendarBtn = el("button", { type: "button", text: "Calendar" }).also((btn) =>
    btn.addEventListener("click", () => {
      view = "calendar";
      viewToggleRow.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderView();
    })
  );
  viewToggleRow.appendChild(listBtn);
  viewToggleRow.appendChild(calendarBtn);

  const allBtn = el("button", { type: "button", text: "All", class: "active" }).also((btn) =>
    btn.addEventListener("click", () => {
      filterRow.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentTeamId = null;
      renderView();
    })
  );
  filterRow.appendChild(allBtn);

  for (const team of teams) {
    const btn = el("button", { type: "button", text: team.name || "" }).also((b) =>
      b.addEventListener("click", () => {
        filterRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        currentTeamId = team.team_id;
        renderView();
      })
    );
    filterRow.appendChild(btn);
  }

  renderView();
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
  // Events read nearest-date-first (what's coming up soonest matters
  // most); News reads newest-first (most recently announced first) - the
  // two lists need opposite sort directions, so they're split into their
  // own sections rather than interleaved in one list.
  const activeEvents = news
    .filter((n) => n.is_event && isNewsActive(n, today))
    .sort((a, b) => (a.published_date || "").localeCompare(b.published_date || ""));
  const activeArticles = news
    .filter((n) => !n.is_event && isNewsActive(n, today))
    .sort((a, b) => (b.published_date || "").localeCompare(a.published_date || ""));

  if (!activeEvents.length && !activeArticles.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No news right now." }));
    return;
  }

  function renderPost(post) {
    main.appendChild(
      el(
        "article",
        { class: "news-post" },
        [
          post.image ? el("img", { class: "plate", src: post.image, alt: "" }) : null,
          el("div", {}, [
            el("span", { class: "eyebrow", text: post.is_event ? `Event · ${post.published_date || ""}` : post.published_date || "" }),
            el("h2", { text: post.title || "", style: "margin-top:0" }),
            el("p", { class: "rich-text", text: post.body || "" }),
          ]),
        ].filter(Boolean)
      )
    );
  }

  if (activeEvents.length) {
    main.appendChild(el("div", { class: "section-divider" }, [el("div", { class: "section-heading" }, [el("h2", { text: "Upcoming Events" })])]));
    activeEvents.forEach(renderPost);
  }
  if (activeArticles.length) {
    main.appendChild(el("div", { class: "section-divider" }, [el("div", { class: "section-heading" }, [el("h2", { text: "News" })])]));
    activeArticles.forEach(renderPost);
  }
}

async function initCoachesPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Coaches");
  setPageTitle(intro?.title || "Coaches");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const [coaches, teams] = await Promise.all([siteFetch("/coaches"), siteFetch("/rosters").catch(() => [])]);
  if (!coaches.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No coaches listed yet." }));
    return;
  }

  // Which team(s) a coach is on isn't stored on the coach - it's the
  // inverse of Rosters' coach_ids many-to-many - so build that lookup
  // here rather than adding a redundant field on Coaches.
  const teamNamesByCoachId = {};
  for (const team of teams) {
    for (const coachId of team.coach_ids || []) {
      (teamNamesByCoachId[coachId] ||= []).push(team.name);
    }
  }

  const grid = el("div", { class: "card-grid" });
  main.appendChild(grid);

  for (const coach of coaches) {
    const teamLabel = (teamNamesByCoachId[coach.coach_id] || []).join(", ");
    const card = el(
      "div",
      { class: "card coach-card", tabindex: "0", role: "button" },
      [
        coach.image ? el("img", { class: "card-photo plate", src: coach.image, alt: coach.name || "" }) : null,
        el("div", { class: "card-body" }, [
          teamLabel ? el("span", { class: "eyebrow", text: teamLabel }) : null,
          el("p", { class: "card-title", text: coach.name || "" }),
          el("p", { class: "card-subtitle", text: coach.title || "" }),
        ].filter(Boolean)),
      ].filter(Boolean)
    );
    // Profile and email are deliberately left off the card - they only
    // show in the popup (openCoachModal), which also highlights this
    // card via .is-active for as long as it's open.
    const openThisCoach = () => openCoachModal(coach, teamLabel, card);
    // Stop the click here so it doesn't also bubble up to the document-
    // level img.plate lightbox listener - the coach photo is a .plate
    // image too, but a click on it should open the coach modal, not the
    // full-size image lightbox.
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      openThisCoach();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openThisCoach();
      }
    });
    grid.appendChild(card);
  }
}

let coachModalBackdrop = null;
function openCoachModal(coach, teamLabel, card) {
  document.querySelectorAll(".coach-card.is-active").forEach((el) => el.classList.remove("is-active"));
  card.classList.add("is-active");

  if (coachModalBackdrop) coachModalBackdrop.remove();

  const closeBtn = el("button", { type: "button", class: "coach-modal-close", "aria-label": "Close" }, [document.createTextNode("×")]);
  const modal = el(
    "div",
    { class: "coach-modal" },
    [
      closeBtn,
      coach.image ? el("img", { class: "plate coach-modal-photo", src: coach.image, alt: coach.name || "" }) : null,
      el("div", { class: "coach-modal-body" }, [
        teamLabel ? el("span", { class: "eyebrow", text: teamLabel }) : null,
        el("h2", { text: coach.name || "", style: "margin-top:0" }),
        el("p", { class: "card-subtitle", text: coach.title || "" }),
        coach.email ? el("a", { href: `mailto:${coach.email}`, text: coach.email }) : null,
        // Fixed-height + its own scroll (not the whole modal) so the
        // photo/name/title/email above always stay on screen even if the
        // profile text runs long.
        coach.profile ? el("div", { class: "coach-modal-profile" }, [el("p", { class: "rich-text", text: coach.profile })]) : null,
      ].filter(Boolean)),
    ].filter(Boolean)
  );

  const backdrop = el("div", { class: "coach-modal-backdrop" }, [modal]);
  coachModalBackdrop = backdrop;
  document.body.appendChild(backdrop);

  function close() {
    card.classList.remove("is-active");
    backdrop.remove();
    if (coachModalBackdrop === backdrop) coachModalBackdrop = null;
    window.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  // The modal's own photo is also a .plate image - without this, clicking
  // it (or anything else inside the modal) would bubble up to the
  // document-level img.plate lightbox listener and open that on top of
  // this modal.
  modal.addEventListener("click", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", close);
  window.addEventListener("keydown", onKey);
}

function contactValueNode(contact) {
  if (contact.type === "Email") {
    return el("a", { href: `mailto:${contact.value}`, text: contact.value || "" });
  } else if (contact.type === "Phone") {
    return el("a", { href: `tel:${(contact.value || "").replace(/[^+\d]/g, "")}`, text: contact.value || "" });
  } else if (contact.type === "Physical Address") {
    return el("a", { href: mapsUrl(contact.value || ""), target: "_blank", text: contact.value || "" });
  } else if (contact.type === "Instagram") {
    const handle = (contact.value || "").replace(/^@/, "");
    return el("a", { href: `https://instagram.com/${handle}`, target: "_blank", text: contact.value || "" });
  }
  return el("span", { text: contact.value || "" });
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

  const gymContact = contacts.find((c) => c.type === "Physical Address");
  const gridContacts = contacts.filter((c) => c !== gymContact);

  if (gridContacts.length) {
    const grid = el("div", { class: "card-grid card-grid--list" });
    for (const contact of gridContacts) {
      grid.appendChild(
        el(
          "div",
          { class: "card card--list" },
          [
            contact.kind ? el("span", { class: "eyebrow", text: contact.kind }) : null,
            el("h3", { text: contact.label || contact.type || "" }),
            contact.role || contact.type
              ? el("p", { class: "card-subtitle", text: contact.role || contact.type })
              : null,
            contactValueNode(contact),
          ].filter(Boolean)
        )
      );
    }
    main.appendChild(grid);
  }

  if (gymContact) {
    const [street, ...rest] = (gymContact.value || "").split(",").map((s) => s.trim());
    const cityLine = rest.join(", ");
    main.appendChild(
      el("div", { class: "gym-section" }, [
        el(
          "div",
          {},
          [
            el("h2", { text: gymContact.label || "Gym" }),
            street ? el("div", { class: "gym-address" }, [el("div", { text: street }), cityLine ? el("div", { text: cityLine }) : null].filter(Boolean)) : null,
            gymContact.role ? el("p", { text: gymContact.role }) : null,
            el("a", { href: mapsUrl(gymContact.value || ""), target: "_blank", class: "btn", text: "Directions" }),
          ].filter(Boolean)
        ),
        el("div", { class: "gym-photo-placeholder plate" }, [el("span", { text: "Map / Photo" })]),
      ])
    );
  }
}

const SPONSOR_TIERS = ["Banner", "Court", "Friend of the Program"];

async function initSponsorsPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Sponsors");
  setPageTitle(intro?.title || "Sponsors");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const sponsors = await siteFetch("/sponsors");
  if (!sponsors.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No sponsors listed yet." }));
    return;
  }

  for (const tier of SPONSOR_TIERS) {
    const tierSponsors = sponsors.filter((s) => s.tier === tier);
    if (!tierSponsors.length) continue;

    const grid = el("div", { class: "card-grid" });
    for (const s of tierSponsors) {
      grid.appendChild(
        el("div", { class: "card" }, [
          el("div", { class: "card-body" }, [
            el("p", { class: "card-title", text: s.name || "" }),
            s.kind ? el("p", { class: "card-subtitle", text: s.kind }) : null,
            s.website ? el("a", { href: s.website, target: "_blank", text: s.website }) : null,
          ].filter(Boolean)),
        ])
      );
    }
    main.appendChild(sectionDivider(tier, [grid]));
  }
}

async function initPhotosPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Photos");
  setPageTitle(intro?.title || "Photos");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const albums = await siteFetch("/albums");
  if (!albums.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No photos yet." }));
    return;
  }

  const photosByAlbum = await Promise.all(
    albums.map((album) => siteFetch(`/photos/${encodeURIComponent(album.album_id)}`).catch(() => []))
  );

  albums.forEach((album, i) => {
    const photos = photosByAlbum[i];

    const section = el("div", { class: "section-divider" }, [
      el("div", { class: "section-heading" }, [
        el("h2", { text: album.title || "" }),
        album.date_label ? el("span", { class: "card-subtitle", text: album.date_label }) : null,
      ].filter(Boolean)),
    ]);

    if (photos.length) {
      const grid = el("div", { class: "card-grid" });
      for (const photo of photos) {
        grid.appendChild(
          el("figure", { class: "card", style: "margin:0" }, [
            el("img", { class: "card-photo plate", src: photo.image || "", alt: photo.caption || "" }),
            photo.caption ? el("figcaption", { class: "card-body", text: photo.caption }) : null,
          ].filter(Boolean))
        );
      }
      section.appendChild(grid);
    }
    main.appendChild(section);
  });
}

const STANDINGS_COLUMNS = [
  ["school", "School"],
  ["league_record", "League W-L"],
  ["league_pct", "League PCT"],
  ["league_pf", "League PF"],
  ["league_pa", "League PA"],
  ["overall_record", "Overall W-L"],
  ["overall_pct", "Overall PCT"],
  ["overall_pf", "Overall PF"],
  ["overall_pa", "Overall PA"],
  ["streak", "Streak"],
];

async function initStandingsPage() {
  const blocks = await initLayout();
  const intro = findBlockByGenerator(blocks, "Standings");
  setPageTitle(intro?.title || "League Standings");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const cache = await siteFetch("/standings");

  const rows = [...(cache?.rows || [])].sort(compareStandingsRows);
  if (!rows.length) {
    main.appendChild(el("p", { class: "empty-state", text: "Standings aren't available yet." }));
    return;
  }

  const tbody = el("tbody");
  for (const row of rows) {
    const schoolCell = el(
      "td",
      {},
      [
        row.link
          ? el("a", { href: row.link, target: "_blank", text: row.school || "" })
          : el("span", { text: row.school || "" }),
      ]
    );

    tbody.appendChild(
      el(
        "tr",
        {},
        STANDINGS_COLUMNS.map(([key]) => (key === "school" ? schoolCell : el("td", { class: "nums", text: row[key] || "" })))
      )
    );
  }

  main.appendChild(
    el("table", {}, [
      el("thead", {}, [el("tr", {}, STANDINGS_COLUMNS.map(([, label]) => el("th", { text: label })))]),
      tbody,
    ])
  );

  if (cache?.updated_at) {
    main.appendChild(
      el("p", {
        class: "card-subtitle",
        text: `Last updated ${new Date(cache.updated_at * 1000).toLocaleString()}`,
      })
    );
  }
}
