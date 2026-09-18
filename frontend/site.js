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

// Albums' `linked` field ties an album to a specific News/Event post
// (`linked.ref === "news:<post_id>"`, see Albums in content-schemas.md) -
// previously admin-only metadata that nothing on the public site read.
// This builds a post_id -> photos[] lookup so a full News/Event article
// can show that post's linked album(s) as a photo carousel at the end.
// Only fetches photos for albums that are actually linked to a post, not
// every album, since most albums have no News/Event link at all.
async function fetchNewsPhotoIndex() {
  const albums = await siteFetch("/albums").catch(() => []);
  const albumsByPostId = {};
  for (const album of albums) {
    const ref = album.linked?.ref || "";
    if (!ref.startsWith("news:")) continue;
    const postId = ref.slice("news:".length);
    (albumsByPostId[postId] ||= []).push(album);
  }
  const linkedAlbums = Object.values(albumsByPostId).flat();
  const photoLists = await Promise.all(
    linkedAlbums.map((a) => siteFetch(`/photos/${encodeURIComponent(a.album_id)}`).catch(() => []))
  );
  const photosByAlbumId = Object.fromEntries(linkedAlbums.map((a, i) => [a.album_id, photoLists[i]]));
  const photosByPostId = {};
  for (const [postId, albumsForPost] of Object.entries(albumsByPostId)) {
    photosByPostId[postId] = albumsForPost.flatMap((a) => photosByAlbumId[a.album_id] || []);
  }
  return photosByPostId;
}

// A horizontally-scrolling strip of small thumbnails shown at the end of
// a News/Event article when it has linked album photos - not a single
// stretched-to-article-width image. Clicking any thumbnail opens
// openPhotoModal with that photo's caption as the modal's title (below).
function buildPhotoCarousel(photos) {
  const thumbs = photos.map((photo) => {
    const thumb = el("img", {
      class: "plate photo-carousel-thumb",
      src: photo.image || "",
      alt: photo.caption || "",
    });
    // stopPropagation - the thumbnail also carries .plate, which the
    // document-level lightbox listener (initImageLightbox) would
    // otherwise also catch on the same click, opening its plain
    // caption-less popup on top of/behind this one.
    thumb.addEventListener("click", (e) => {
      e.stopPropagation();
      openPhotoModal(photo);
    });
    return thumb;
  });

  return el("div", { class: "photo-carousel" }, thumbs);
}

// Full-size photo popup - the modal's own title (<h2>) is the photo's
// caption, per explicit request, not a generic "Photo" label.
let photoModalBackdrop = null;
function openPhotoModal(photo) {
  if (photoModalBackdrop) photoModalBackdrop.remove();

  const closeBtn = el("button", { type: "button", class: "photo-modal-close", "aria-label": "Close" }, [document.createTextNode("×")]);
  const modal = el("div", { class: "photo-modal" }, [
    closeBtn,
    el("img", { class: "photo-modal-img", src: photo.image || "", alt: photo.caption || "" }),
    photo.caption ? el("h2", { class: "photo-modal-caption", text: photo.caption }) : null,
  ].filter(Boolean));

  const backdrop = el("div", { class: "photo-modal-backdrop" }, [modal]);
  photoModalBackdrop = backdrop;
  document.body.appendChild(backdrop);

  function close() {
    backdrop.remove();
    if (photoModalBackdrop === backdrop) photoModalBackdrop = null;
    window.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  modal.addEventListener("click", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", close);
  window.addEventListener("keydown", onKey);
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
  Store: "store.html",
  Sponsorships: "sponsorships.html",
  Donate: "donate.html",
};

// Sidebar nav is a fixed structure (Home/Store top-level, then three
// grouped sections) rather than being driven purely by Content Block
// `order`, per explicit request - group headers below are hardcoded
// labels, but each link's own text still comes from its Content Block's
// `title` so the admin can rename any page's label freely. A generator
// with no matching Content Block yet (e.g. a brand new Store/
// Sponsorships/Donate block not yet created in the admin) falls back to
// the generator's own name as a placeholder label, so the page is still
// reachable before that block exists.
const NAV_STRUCTURE = [
  { home: true },
  { generator: "Store" },
  { group: "Media", items: ["News", "Photos", "Sponsors"] },
  { group: "Basketball", items: ["Schedule", "Standings", "Rosters", "Coaches"] },
  { group: "Booster", items: ["Mission Statement", "Contact Us", "Sponsorships", "Donate"] },
];

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
    const target = e.target.closest("img.plate, img.thumb-clickable");
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

  // All four run in parallel (not content-blocks awaited alone, then the
  // rest) - every page needs at least blocks+teams, so serializing them
  // just adds a second round-trip before the page's own fetches can even
  // start. The caller-side page functions also reuse teams/contacts/
  // standingsCache from the returned object below instead of re-fetching
  // the same /rosters, /contacts, or /standings themselves.
  const [blocks, teams, contacts, standingsCache] = await Promise.all([
    siteFetch("/content-blocks").catch(() => []),
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
    sidebar.appendChild(el("span", { class: "eyebrow record-box-label", text: "Varsity" }));
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

  function classAttr(...parts) {
    const cls = parts.filter(Boolean).join(" ");
    return cls ? { class: cls } : {};
  }

  const navItems = [];
  for (const entry of NAV_STRUCTURE) {
    if (entry.home) {
      const homeBlock = findBlock(blocks, "Home");
      navItems.push(
        el("a", { href: "index.html", text: homeBlock?.title || "Home", ...classAttr(currentFile === "index.html" && "active") })
      );
      continue;
    }
    if (entry.group) {
      navItems.push(el("div", { class: "nav-group-label", text: entry.group }));
      for (const generator of entry.items) {
        const block = findBlockByGenerator(blocks, generator);
        const href = pageForGenerator(generator);
        const isRosters = generator === "Rosters";
        const isActive = href === currentFile || (isRosters && currentFile === "roster.html");
        navItems.push(el("a", { href, text: block?.title || generator, ...classAttr("sub-link", isActive && "active") }));

        if (isRosters) {
          for (const team of teams) {
            const teamActive = currentFile === "roster.html" && currentTeamId === team.team_id;
            navItems.push(
              el("a", {
                href: `roster.html?team=${encodeURIComponent(team.team_id)}`,
                text: team.name || "",
                ...classAttr("sub-link", "sub-link--team", teamActive && "active"),
              })
            );
          }
        }
      }
      continue;
    }
    // Top-level, non-grouped generator-driven link (Store).
    const block = findBlockByGenerator(blocks, entry.generator);
    const href = pageForGenerator(entry.generator);
    navItems.push(el("a", { href, text: block?.title || entry.generator, ...classAttr(href === currentFile && "active") }));
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

  return { blocks, teams, contacts, standingsCache };
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
  const { blocks, teams: rosters, contacts, standingsCache: standings } = await initLayout();
  const homeBlock = findBlock(blocks, "Home");
  const logoBlock = findBlockByGenerator(blocks, "Logo");
  setPageTitle(homeBlock?.title || "Welcome");
  const main = document.getElementById("page-content");
  main.appendChild(el("span", { class: "eyebrow", text: `${defaultSeason()} Season` }));

  const [news, sponsors, allGames, locations, photosByPostId] = await Promise.all([
    siteFetch("/news"),
    siteFetch("/sponsors").catch(() => []),
    siteFetch(`/schedule/${defaultSeason()}`).catch(() => []),
    siteFetch("/locations").catch(() => []),
    fetchNewsPhotoIndex(),
  ]);

  const today = isoDate(new Date());
  const locationsById = Object.fromEntries(locations.map((l) => [l.location_id, l]));
  const gymContact = contacts.find((c) => c.type === "Physical Address");

  function gameLine(g) {
    return `${g.home_away === "Home" ? "vs" : "at"} ${g.opponent || ""}`;
  }

  // Same denormalized-location resolution as the Schedule page's
  // gameLocation() - resolves location_id live so a renamed Location
  // shows up here too, falling back to the game's own stored text.
  function gameAddress(g) {
    if (g.home_away === "Home") return gymContact?.value || "";
    const loc = g.location_id && locationsById[g.location_id];
    return (loc && loc.address) || g.address || "";
  }

  function gameMapsHref(g) {
    const address = gameAddress(g);
    return address ? mapsUrl(address) : null;
  }

  const statRow = el("div", { class: "stat-row" });

  function renderStatRow(teamId) {
    statRow.innerHTML = "";
    const teamGames = teamId ? allGames.filter((g) => g.team_id === teamId) : allGames;
    const sortedGames = [...teamGames].filter((g) => g.date).sort((a, b) => a.date.localeCompare(b.date));
    const played = sortedGames.filter((g) => g.date < today && g.our_score && g.opponent_score);
    const lastResult = played[played.length - 1];
    const upcomingGames = sortedGames.filter((g) => g.date >= today);
    const nextGame = upcomingGames[0];
    const thenGames = upcomingGames.slice(1, 4);

    if (lastResult) {
      const won = Number(lastResult.our_score) > Number(lastResult.opponent_score);
      statRow.appendChild(
        el("div", { class: "stat-col" }, [
          el("span", { class: "eyebrow", text: "Last Result" }),
          el("div", {
            class: `stat-value nums ${won ? "result-win" : "result-loss"}`,
            text: `${lastResult.our_score} – ${lastResult.opponent_score}`,
          }),
          el("p", { class: "stat-meta", text: gameLine(lastResult) }),
          el("p", { class: "stat-meta nums", text: lastResult.date }),
        ])
      );
    }
    if (nextGame) {
      const href = gameMapsHref(nextGame);
      const valueText = `${nextGame.home_away === "Home" ? "vs" : "at"} ${nextGame.opponent || ""}`;
      statRow.appendChild(
        el("div", { class: "stat-col" }, [
          el("span", { class: "eyebrow", text: "Next Game" }),
          href
            ? el("a", { class: "stat-value", href, target: "_blank", text: valueText })
            : el("div", { class: "stat-value", text: valueText }),
          el("p", { class: "stat-meta nums", text: `${nextGame.date}${nextGame.time ? " · " + nextGame.time : ""}` }),
        ])
      );
    }
    if (thenGames.length) {
      statRow.appendChild(
        el("div", { class: "stat-col stat-col--wide" }, [
          el("span", { class: "eyebrow", text: "Upcoming" }),
          ...thenGames.map((g) => {
            const href = gameMapsHref(g);
            const label = href
              ? el("a", { href, target: "_blank", text: gameLine(g) })
              : el("span", { text: gameLine(g) });
            return el("div", { class: "stat-list-row" }, [label, el("span", { class: "nums", text: g.date })]);
          }),
          el("a", { class: "stat-list-link", href: "schedule.html", text: "Full schedule →" }),
        ])
      );
    }
  }

  // Team toggle next to the season eyebrow - lets a visitor see the same
  // Last Result / Next Game / Upcoming trio for JV/Frosh instead of just
  // Varsity, which is the default (matched by name, falling back to the
  // first roster if no team is literally named "Varsity").
  if (rosters.length > 1) {
    const teamRow = el("div", { class: "filter-row" });
    const defaultTeam = rosters.find((t) => (t.name || "").toLowerCase() === "varsity") || rosters[0];
    for (const team of rosters) {
      const btn = el("button", {
        type: "button",
        text: team.name || "",
        ...(team.team_id === defaultTeam.team_id ? { class: "active" } : {}),
      }).also((b) =>
        b.addEventListener("click", () => {
          teamRow.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          renderStatRow(team.team_id);
        })
      );
      teamRow.appendChild(btn);
    }
    main.appendChild(teamRow);
    renderStatRow(defaultTeam.team_id);
  } else {
    renderStatRow(rosters[0]?.team_id || null);
  }
  if (statRow.children.length) main.appendChild(statRow);

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

  // If a card's excerpt overflows its fixed-height box, add a "Full
  // Article" link that opens the full text in a modal (openNewsModal)
  // rather than growing the card or scrolling the whole page section.
  function addFullArticleLink(excerptEl, containerEl, item) {
    if (excerptEl.scrollHeight <= excerptEl.clientHeight + 1) return;
    const link = el("a", { class: "stat-list-link", href: "#", text: "Full Article" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openNewsModal(item, photosByPostId[item.post_id] || []);
    });
    containerEl.appendChild(link);
  }

  if (lead) {
    const leadExcerpt = el("div", { class: "news-excerpt rich-text" }, [document.createTextNode(lead.body || "")]);
    const leadCol = el("div", {}, [
      el("h3", { text: lead.title || "" }),
      el("p", { class: "stat-meta nums", text: lead.published_date || "" }),
      leadExcerpt,
    ]);
    main.appendChild(
      el("div", { class: "section-divider" }, [
        el("div", { class: "section-heading" }, [el("h2", { text: "News" }), el("a", { href: "news.html", text: "Read more →" })]),
        el(
          "article",
          { class: "news-lead" },
          [leadCol, lead.image ? el("img", { class: "plate news-lead-photo", src: lead.image, alt: "" }) : null].filter(Boolean)
        ),
        rest.length
          ? el(
              "div",
              { class: "news-grid" },
              rest.slice(0, 3).map((n) => {
                const excerpt = el("div", { class: "news-excerpt-card card-subtitle" }, [document.createTextNode(n.body || "")]);
                const card = el("div", {}, [
                  el("h4", { text: n.title || "" }),
                  el("p", { class: "stat-meta nums", text: n.published_date || "" }),
                  excerpt,
                ]);
                addFullArticleLink(excerpt, card, n);
                return card;
              })
            )
          : null,
      ].filter(Boolean))
    );
    addFullArticleLink(leadExcerpt, leadCol, lead);
  }

  // Per request: the Home content block's text sits between the news feed
  // and the standings teaser, not at the very top of the page.
  if (homeBlock?.body) main.appendChild(el("p", { class: "page-intro", text: homeBlock.body }));

  const standingsRows = [...(standings?.rows || [])].sort(compareStandingsRows);
  if (standingsRows.length) {
    const tbody = el("tbody");
    for (const row of standingsRows) {
      const isUs = logoBlock && (row.school || "").toLowerCase() === (logoBlock.title || "").toLowerCase();
      const [leagueWins, leagueLosses] = (row.league_record || "-").split("-");
      const [overallWins, overallLosses] = (row.overall_record || "-").split("-");
      tbody.appendChild(
        el("tr", isUs ? { class: "standings-row-us" } : {}, [
          el("td", { class: "col-school" }, [
            row.link
              ? el("a", { href: row.link, target: "_blank", text: row.school || "" })
              : el("span", { text: row.school || "" }),
          ]),
          el("td", { class: "nums", text: leagueWins || "" }),
          el("td", { class: "nums", text: leagueLosses || "" }),
          el("td", { class: "nums", text: overallWins || "" }),
          el("td", { class: "nums", text: overallLosses || "" }),
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
          el("span", { class: "eyebrow", text: "Varsity" }),
        ]),
        el("table", { class: "standings-table", style: "margin-top:0.75rem" }, [
          el(
            "colgroup",
            {},
            ["25%", "9.375%", "9.375%", "9.375%", "9.375%", "9.375%", "9.375%", "18.75%"].map((w) => el("col", { style: `width:${w}` }))
          ),
          el("thead", {}, [
            el("tr", {}, [
              el("th", { class: "col-school", rowspan: "2", text: "School" }),
              el("th", { colspan: "2", text: "League" }),
              el("th", { colspan: "2", text: "Overall" }),
              el("th", { rowspan: "2", text: "PF" }),
              el("th", { rowspan: "2", text: "PA" }),
              el("th", { rowspan: "2", text: "Streak" }),
            ]),
            el("tr", {}, [
              el("th", { text: "W" }),
              el("th", { text: "L" }),
              el("th", { text: "W" }),
              el("th", { text: "L" }),
            ]),
          ]),
          tbody,
        ]),
        el("a", { class: "stat-list-link", href: "standings.html", text: "Full standings →" }),
      ])
    );
  }

  if (sponsors.length) {
    const sortedSponsors = [...sponsors].sort((a, b) => {
      const tierDiff = SPONSOR_TIERS.indexOf(a.tier) - SPONSOR_TIERS.indexOf(b.tier);
      return tierDiff !== 0 ? tierDiff : (a.name || "").localeCompare(b.name || "");
    });
    main.appendChild(
      sectionDivider("Sponsors", [
        el(
          "p",
          { class: "sponsors" },
          sortedSponsors.flatMap((s, i) => [
            i > 0 ? document.createTextNode(" · ") : null,
            s.website ? el("a", { href: s.website, target: "_blank", text: s.name || "" }) : el("span", { text: s.name || "" }),
          ].filter(Boolean))
        ),
      ])
    );
  }
}

// Renders `body` as real HTML (innerHTML), not plain text - the Mission
// Statement content is authored with headings/lists (see the admin's
// Write/Preview toggle on the Body field, "HTML is allowed"), so it needs
// to actually render as markup here rather than showing literal tags.
// Same trust level as any other Content Block body - only an
// authenticated admin can ever set it.
async function initMissionPage() {
  const { blocks } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Mission Statement");
  setPageTitle(intro?.title || "Mission Statement");
  const main = document.getElementById("page-content");
  if (intro?.body) {
    const container = el("div", { class: "rich-text rich-text-html" });
    container.innerHTML = intro.body;
    main.appendChild(container);
  }
}

// Store/Sponsorships/Donate are plain embed pages - the admin pastes raw
// HTML (an embedded store widget, a payment-processor donate button/iframe,
// a sponsorship pitch deck, etc.) straight into the block's Body field, so
// unlike every other generator page this renders `body` as real HTML
// (innerHTML) instead of text. Safe to do since only an authenticated
// admin (gated by the write endpoints' permission check) can ever set it -
// same trust level as any other CMS body field, just actually rendered as
// HTML here instead of only in the admin's own Write/Preview toggle.
async function initHtmlBlockPage(generator, fallbackTitle) {
  const { blocks } = await initLayout();
  const block = findBlockByGenerator(blocks, generator);
  setPageTitle(block?.title || fallbackTitle);
  const main = document.getElementById("page-content");
  if (block?.body) {
    const container = el("div", { class: "rich-text rich-text-html" });
    container.innerHTML = block.body;
    main.appendChild(container);
  } else {
    main.appendChild(el("p", { class: "empty-state", text: "Nothing here yet." }));
  }
}

async function initRostersPage() {
  const { blocks, teams } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Rosters");
  setPageTitle(intro?.title || "Rosters");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

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

  const teamDetails = el(
    "div",
    {},
    [
      coachNames ? el("span", { class: "eyebrow", text: "Coaching Staff" }) : null,
      coachNames ? el("p", { class: "card-subtitle", text: coachNames }) : null,
      team.description ? el("p", { class: "rich-text", text: team.description }) : null,
    ].filter(Boolean)
  );
  if (team.image) {
    // Two-panel grid (photo | details) instead of a full-width photo -
    // the photo stays clickable for the full-size lightbox (img.plate,
    // see initImageLightbox) even at this smaller display size.
    main.appendChild(
      el("div", { class: "roster-detail-header" }, [
        el("img", { class: "card-photo plate", src: team.image, alt: team.name || "" }),
        teamDetails,
      ])
    );
  } else if (teamDetails.children.length) {
    main.appendChild(teamDetails);
  }

  if (!players.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No players listed yet." }));
    return;
  }

  const PLAYER_COLUMNS = [
    { label: "" },
    { label: "First name", key: "first_name" },
    { label: "Last name", key: "last_name" },
    { label: "#", key: "number" },
    { label: "Height", key: "height" },
    { label: "Year", key: "year" },
  ];
  let sortKey = null;
  let sortAsc = true;

  function comparePlayers(a, b) {
    const av = a[sortKey] ?? "";
    const bv = b[sortKey] ?? "";
    const an = Number(av);
    const bn = Number(bv);
    const cmp = av !== "" && bv !== "" && !isNaN(an) && !isNaN(bn) ? an - bn : String(av).localeCompare(String(bv));
    return sortAsc ? cmp : -cmp;
  }

  const tbody = el("tbody");
  const thead = el("thead");
  main.appendChild(
    sectionDivider("Players", [el("table", {}, [thead, tbody])])
  );

  function paintHeader() {
    thead.innerHTML = "";
    thead.appendChild(
      el(
        "tr",
        {},
        PLAYER_COLUMNS.map((col) => {
          if (!col.key) return el("th", { text: col.label });
          const arrow = sortKey === col.key ? (sortAsc ? " ▲" : " ▼") : "";
          const th = el("th", { text: col.label + arrow, style: "cursor:pointer" });
          th.addEventListener("click", () => {
            sortAsc = sortKey === col.key ? !sortAsc : true;
            sortKey = col.key;
            paintHeader();
            paintRows();
          });
          return th;
        })
      )
    );
  }

  function paintRows() {
    const rows = sortKey ? [...players].sort(comparePlayers) : players;
    tbody.innerHTML = "";
    for (const p of rows) {
      // Player photos skip .plate (the sepia mat would overwhelm a 40px
      // thumbnail - see the roster table gotcha), but still open the
      // same full-size lightbox on click via the shared .thumb-clickable
      // class (see initImageLightbox's delegated listener).
      const photoCell = el("td");
      if (p.image) photoCell.appendChild(el("img", { class: "thumb-clickable", src: p.image, alt: "", style: "width:40px;height:40px;object-fit:cover;border-radius:6px" }));
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
  }

  paintHeader();
  paintRows();
}

async function initSchedulePage() {
  const { blocks, teams, contacts } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Schedule");
  setPageTitle(intro?.title || "Schedule");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const gymContact = contacts.find((c) => c.type === "Physical Address");
  const [games, locations] = await Promise.all([siteFetch(`/schedule/${defaultSeason()}`), siteFetch("/locations")]);
  const locationsById = Object.fromEntries(locations.map((l) => [l.location_id, l]));

  // Schedule denormalizes a Location's name/address onto the game at save
  // time (so this page doesn't strictly need this lookup) - but resolving
  // live off location_id here means renaming a Location later shows up
  // immediately, instead of only on the next time that game is re-saved.
  function gameLocation(g) {
    const loc = g.location_id && locationsById[g.location_id];
    return { name: (loc && loc.name) || g.location || "", address: (loc && loc.address) || g.address || "" };
  }

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
        if (g.home_away === "Home") {
          addressCell.appendChild(
            gymContact
              ? el("a", { href: mapsUrl(gymContact.value || ""), target: "_blank", class: "maps-link", text: "Home" })
              : el("span", { text: "Home" })
          );
        } else {
          const { name: locName, address: locAddress } = gameLocation(g);
          if (locAddress) {
            addressCell.appendChild(
              el("a", { href: mapsUrl(locAddress), target: "_blank", class: "maps-link", text: locName || "Map" })
            );
          } else if (locName) {
            addressCell.appendChild(el("span", { text: locName }));
          }
        }

        let scoreCell;
        if (g.our_score && g.opponent_score) {
          const won = Number(g.our_score) > Number(g.opponent_score);
          scoreCell = el("td", {
            class: `nums ${won ? "result-win" : "result-loss"}`,
            text: `${g.our_score} : ${g.opponent_score} (${won ? "W" : "L"})`,
          });
        } else if (g.our_score || g.opponent_score) {
          scoreCell = el("td", { class: "nums", text: `${g.our_score || "-"} : ${g.opponent_score || "-"}` });
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
  const { blocks } = await initLayout();
  const intro = findBlockByGenerator(blocks, "News");
  setPageTitle(intro?.title || "News");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const [news, photosByPostId] = await Promise.all([siteFetch("/news"), fetchNewsPhotoIndex()]);
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
    const photos = photosByPostId[post.post_id] || [];
    main.appendChild(
      el(
        "article",
        { class: "news-post" },
        [
          post.image ? el("img", { class: "plate", src: post.image, alt: "" }) : null,
          el("div", {}, [
            el("h2", { text: post.title || "", style: "margin-top:0" }),
            el("p", { class: "stat-meta nums", text: post.published_date || "" }),
            el("p", { class: "rich-text", text: post.body || "" }),
            photos.length ? buildPhotoCarousel(photos) : null,
          ].filter(Boolean)),
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
  const { blocks, teams } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Coaches");
  setPageTitle(intro?.title || "Coaches");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const coaches = await siteFetch("/coaches");
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

// Same fixed-height-modal-with-scrolling-content layout as openCoachModal
// above, reused here for a News/Event item's full text (see
// addFullArticleLink in initHomePage) - only the .news-modal-content box
// scrolls, so the title/date stay pinned on screen.
let newsModalBackdrop = null;
function openNewsModal(item, photos = []) {
  if (newsModalBackdrop) newsModalBackdrop.remove();

  const closeBtn = el("button", { type: "button", class: "news-modal-close", "aria-label": "Close" }, [document.createTextNode("×")]);
  const modal = el(
    "div",
    { class: "news-modal" },
    [
      closeBtn,
      item.image ? el("img", { class: "plate news-modal-photo", src: item.image, alt: "" }) : null,
      el("div", { class: "news-modal-body" }, [
        el("h2", { text: item.title || "", style: "margin-top:0" }),
        el("p", { class: "stat-meta nums", text: item.published_date || "" }),
        el("div", { class: "news-modal-content" }, [
          el("p", { class: "rich-text", text: item.body || "" }),
          photos.length ? buildPhotoCarousel(photos) : null,
        ].filter(Boolean)),
      ]),
    ].filter(Boolean)
  );

  const backdrop = el("div", { class: "news-modal-backdrop" }, [modal]);
  newsModalBackdrop = backdrop;
  document.body.appendChild(backdrop);

  function close() {
    backdrop.remove();
    if (newsModalBackdrop === backdrop) newsModalBackdrop = null;
    window.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
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
  } else if (contact.type === "Website") {
    const url = (contact.value || "").match(/^https?:\/\//) ? contact.value : `https://${contact.value || ""}`;
    return el("a", { href: url, target: "_blank", text: contact.value || "" });
  }
  return el("span", { text: contact.value || "" });
}

async function initContactPage() {
  const { blocks, contacts: fetchedContacts } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Contact Us");
  setPageTitle(intro?.title || "Contact Us");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const contacts = [...fetchedContacts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
      el("div", { class: "gym-section", id: "gym" }, [
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
  const { blocks } = await initLayout();
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
  const { blocks } = await initLayout();
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
      album.description ? el("p", { class: "page-intro", text: album.description }) : null,
    ].filter(Boolean));

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
  { key: "school", label: "School" },
  { key: "league_record", label: "W-L", group: "League" },
  { key: "league_pct", label: "PCT", group: "League" },
  { key: "league_pf", label: "PF", group: "League" },
  { key: "league_pa", label: "PA", group: "League" },
  { key: "overall_record", label: "W-L", group: "Overall" },
  { key: "overall_pct", label: "PCT", group: "Overall" },
  { key: "overall_pf", label: "PF", group: "Overall" },
  { key: "overall_pa", label: "PA", group: "Overall" },
  { key: "streak", label: "Streak" },
];

async function initStandingsPage() {
  const { blocks, standingsCache: cache } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Standings");
  setPageTitle(intro?.title || "League Standings");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const rows = [...(cache?.rows || [])].sort(compareStandingsRows);
  if (!rows.length) {
    main.appendChild(el("p", { class: "empty-state", text: "Standings aren't available yet." }));
    return;
  }

  const tbody = el("tbody");
  for (const row of rows) {
    const schoolCell = el(
      "td",
      { class: "col-school" },
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
        STANDINGS_COLUMNS.map(({ key }) => (key === "school" ? schoolCell : el("td", { class: "nums", text: row[key] || "" })))
      )
    );
  }

  // <col> widths (rather than relying on header cell widths) so School
  // gets real extra room regardless of the grouped League/Overall header
  // above using colspan - fixed table layout only reads column widths
  // reliably from a colgroup once any header row spans multiple columns.
  const colgroup = el(
    "colgroup",
    {},
    STANDINGS_COLUMNS.map(({ key }) => el("col", { style: key === "school" ? "width:22%" : key === "streak" ? "width:8%" : "width:8.75%" }))
  );

  const groupHeaderRow = el("tr", {}, [el("th", { class: "col-school", rowspan: "2", text: "School" })]);
  let i = 1;
  while (i < STANDINGS_COLUMNS.length) {
    const { group } = STANDINGS_COLUMNS[i];
    if (!group) {
      groupHeaderRow.appendChild(el("th", { rowspan: "2", text: STANDINGS_COLUMNS[i].label }));
      i++;
      continue;
    }
    let span = 0;
    while (i + span < STANDINGS_COLUMNS.length && STANDINGS_COLUMNS[i + span].group === group) span++;
    groupHeaderRow.appendChild(el("th", { colspan: String(span), text: group }));
    i += span;
  }
  const subHeaderRow = el(
    "tr",
    {},
    STANDINGS_COLUMNS.filter((c) => c.group).map((c) => el("th", { text: c.label }))
  );

  main.appendChild(
    el("table", { class: "standings-table" }, [colgroup, el("thead", {}, [groupHeaderRow, subHeaderRow]), tbody])
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
