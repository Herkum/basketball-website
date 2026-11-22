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
  "Regional Leagues": "regional-leagues.html",
  "Mission Statement": "mission.html",
  Store: "store.html",
  Sponsorships: "sponsorships.html",
  Donate: "donate.html",
  "Games Online": "games-online.html",
};

// Sidebar nav is a fixed structure (Home/Store/Donate top-level, then three
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
  // Store links straight out to the promo-ops team store (new tab) rather
  // than to store.html; its label still comes from the Store block's title.
  { generator: "Store", href: "https://npbasketball.promo-ops.com/" },
  { generator: "Donate" },
  { group: "Media", items: ["News", "Photos", "Sponsors", "Games Online", "Regional Leagues"] },
  { group: "Basketball", items: ["Schedule", "Standings", "Rosters", "Coaches"] },
  {
    group: "Booster",
    items: [
      "Mission Statement",
      "Contact Us",
      "Sponsorships",
    ],
  },
];

function pageForGenerator(generator) {
  return GENERATOR_PAGES[generator] || "index.html";
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

// Phone-width menu: below 720px the sidebar (record box + nav) is hidden
// behind this header button rather than stacking above every page's
// content (see `body.nav-open` in site.css). Added before initLayout's
// fetches so the button is there as soon as the page paints.
function initNavToggle() {
  const headerInner = document.querySelector(".site-header-inner");
  const sidebar = document.getElementById("site-sidebar");
  if (!headerInner || !sidebar || headerInner.querySelector(".nav-toggle")) return;
  const button = el("button", {
    type: "button",
    class: "nav-toggle",
    "aria-controls": "site-sidebar",
    "aria-expanded": "false",
    text: "Menu",
  });
  function setOpen(open) {
    document.body.classList.toggle("nav-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Close" : "Menu";
  }
  button.addEventListener("click", () => setOpen(!document.body.classList.contains("nav-open")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
      setOpen(false);
      button.focus();
    }
  });
  headerInner.appendChild(button);
}

async function initLayout() {
  initImageLightbox();
  initNavToggle();
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
    sidebar.appendChild(
      el("div", { class: "record-card" }, [
        el("div", { class: "record-box-label", text: "Varsity Record" }),
        el("div", { class: "record-box" }, [
          el("div", { class: "record-col" }, [
            el("div", { class: "record-value nums", text: ourStandingsRow.overall_record || "" }),
            el("div", { class: "record-col-label", text: "Overall" }),
          ]),
          el("div", { class: "record-col" }, [
            el("div", { class: "record-value nums", text: ourStandingsRow.league_record || "" }),
            el("div", { class: "record-col-label", text: "League" }),
          ]),
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
        // External link (no generator/page of its own) - opens in a new tab.
        if (typeof generator === "object") {
          navItems.push(
            el("a", { href: generator.href, text: generator.label, target: "_blank", rel: "noopener", class: "sub-link" })
          );
          continue;
        }
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
    // Top-level, non-grouped generator-driven link (Store, Donate).
    const block = findBlockByGenerator(blocks, entry.generator);
    const label = block?.title || entry.generator;
    if (entry.href) {
      navItems.push(el("a", { href: entry.href, text: label, target: "_blank", rel: "noopener" }));
      continue;
    }
    const href = pageForGenerator(entry.generator);
    navItems.push(el("a", { href, text: label, ...classAttr(href === currentFile && "active") }));
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
  // Page-specific fetches start before awaiting initLayout() (here and in
  // every other initXPage) so they run alongside the layout's own fetches
  // instead of waiting a full round-trip for them first.
  const pageData = Promise.all([
    siteFetch("/news"),
    siteFetch("/sponsors").catch(() => []),
    siteFetch(`/schedule/${defaultSeason()}`).catch(() => []),
    siteFetch("/locations").catch(() => []),
    fetchNewsPhotoIndex(),
  ]);
  const { blocks, teams: rosters, contacts, standingsCache: standings } = await initLayout();
  const homeBlock = findBlock(blocks, "Home");
  const logoBlock = findBlockByGenerator(blocks, "Logo");
  setPageTitle(homeBlock?.title || "Welcome");
  const main = document.getElementById("page-content");
  main.appendChild(el("span", { class: "eyebrow", text: `${defaultSeason()} Season` }));

  const [news, sponsors, allGames, locations, photosByPostId] = await pageData;

  const today = isoDate(new Date());
  const locationsById = Object.fromEntries(locations.map((l) => [l.location_id, l]));
  const gymContact = contacts.find((c) => c.type === "Physical Address");

  function gameLine(g) {
    return `${matchupPrefix(g)} ${g.opponent || ""}`;
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
          el("div", { class: "stat-value nums" }, [
            el("span", { class: `stat-result-badge ${won ? "is-win" : "is-loss"}`, text: won ? "W" : "L" }),
            el("span", { text: `${lastResult.our_score} – ${lastResult.opponent_score}` }),
          ]),
          el("p", { class: "stat-meta", text: gameLine(lastResult) }),
          el("p", { class: "stat-meta nums", text: lastResult.date }),
        ])
      );
    }
    if (nextGame) {
      const href = gameMapsHref(nextGame);
      const valueText = `${matchupPrefix(nextGame)} ${nextGame.opponent || ""}`;
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

  // Abbreviated standings (Overall W-L only, best overall record first)
  // beside a random Sponsor Spotlight - the full league table lives on
  // standings.html, so Home only needs an at-a-glance version.
  const byOverall = (a, b) => {
    const ar = parseRecord(a.overall_record);
    const br = parseRecord(b.overall_record);
    return br.wins - ar.wins || ar.losses - br.losses || compareStandingsRows(a, b);
  };
  const standingsRows = [...(standings?.rows || [])].sort(byOverall);
  const spotlight = sponsors.length ? sponsors[Math.floor(Math.random() * sponsors.length)] : null;

  const homeCards = [];
  if (standingsRows.length) {
    homeCards.push(
      el("div", { class: "home-card" }, [
        el("span", { class: "eyebrow", text: "Varsity Standings · Overall" }),
        el("h3", { class: "home-card-title", text: logoBlock?.league_name || "League Standings" }),
        el("table", { class: "standings-mini" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { class: "col-school", text: "School" }),
              el("th", { text: "W" }),
              el("th", { text: "L" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            standingsRows.map((row) => {
              const isUs = logoBlock && (row.school || "").toLowerCase() === (logoBlock.title || "").toLowerCase();
              const { wins, losses } = parseRecord(row.overall_record);
              return el("tr", isUs ? { class: "standings-row-us" } : {}, [
                el("td", { class: "col-school" }, [
                  el("span", { class: "school-badge", "aria-hidden": "true", style: schoolBadgeStyle(row.school), text: schoolInitials(row.school) }),
                  el("span", { text: row.school || "" }),
                ]),
                el("td", { class: "nums", text: String(wins) }),
                el("td", { class: "nums", text: String(losses) }),
              ]);
            })
          ),
        ]),
        el("a", { class: "stat-list-link", href: "standings.html", text: "Full standings →" }),
      ])
    );
  }
  if (spotlight) {
    homeCards.push(
      el("div", { class: "home-card home-card--sponsor" }, [
        el("span", { class: "eyebrow", text: "Sponsor Spotlight" }),
        spotlight.tier ? el("span", { class: "sponsor-tier", text: spotlight.tier }) : null,
        el("h3", { class: "sponsor-spotlight-name", text: spotlight.name || "" }),
        spotlight.kind ? el("p", { class: "sponsor-spotlight-kind", text: spotlight.kind }) : null,
        spotlight.website
          ? el("a", { class: "sponsor-spotlight-link", href: spotlight.website, target: "_blank", rel: "noopener", text: "Visit website →" })
          : null,
        el("p", { class: "sponsor-spotlight-thanks", text: "Thank you for supporting Panther basketball." }),
        el("a", { class: "stat-list-link", href: "sponsors.html", text: "All sponsors →" }),
      ].filter(Boolean))
    );
  }
  if (homeCards.length) main.appendChild(el("div", { class: "home-split section-divider" }, homeCards));
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

// Store/Sponsorships/Donate/Games Online are plain embed pages - the admin
// pastes raw HTML (an embedded store widget, a payment-processor donate
// button/iframe, a sponsorship pitch deck, links out to Hudl, etc.) straight into the block's Body field, so
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
  const teamId = new URLSearchParams(window.location.search).get("team");
  const pageData = teamId
    ? Promise.all([
        siteFetch(`/rosters/${encodeURIComponent(teamId)}`),
        siteFetch(`/players/${encodeURIComponent(teamId)}`),
        siteFetch("/coaches"),
      ])
    : null;
  await initLayout();
  const main = document.getElementById("page-content");

  if (!teamId) {
    setPageTitle("Roster");
    main.appendChild(el("p", { class: "empty-state", text: "No team specified." }));
    return;
  }

  const [team, players, coaches] = await pageData;
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
    sectionDivider("Players", [el("div", { class: "table-scroll" }, [el("table", {}, [thead, tbody])])])
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
  const pageData = Promise.all([siteFetch(`/schedule/${defaultSeason()}`), siteFetch("/locations")]);
  const { blocks, teams, contacts } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Schedule");
  setPageTitle(intro?.title || "Schedule");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const gymContact = contacts.find((c) => c.type === "Physical Address");
  const [games, locations] = await pageData;
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
            el("td", { text: matchupPrefix(g) }),
            el("td", { text: g.opponent || "" }),
            addressCell,
            scoreCell,
          ])
        );
      }

      const count = group.games.length;
      tableContainer.appendChild(
        sectionDivider(`${group.label} · ${count} game${count === 1 ? "" : "s"}`, [
          el("div", { class: "table-scroll" }, [el("table", { class: "schedule-table" }, [
            el(
              "thead",
              {},
              [el("tr", {}, ["Date", "Time", "Team", "", "Opponent", "Location", "Score"].map((t) => el("th", { text: t })))]
            ),
            tbody,
          ])]),
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
        const label = [g.time, matchupPrefix(g), g.opponent, teamName && `(${teamName})`]
          .filter(Boolean)
          .join(" ");
        cell.appendChild(el("div", { class: "calendar-event", text: label }));
      }
      grid.appendChild(cell);
    }
    // Pad the last week out to Saturday too - otherwise the grid's own
    // background (which draws the 1px lines between cells) shows through
    // as a solid block after the month's last day.
    const trailing = (7 - ((firstOfMonth.getDay() + daysInMonth) % 7)) % 7;
    for (let i = 0; i < trailing; i++) {
      grid.appendChild(el("div", { class: "calendar-cell calendar-cell-empty" }));
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
  const pageData = Promise.all([siteFetch("/news"), fetchNewsPhotoIndex()]);
  const { blocks } = await initLayout();
  const intro = findBlockByGenerator(blocks, "News");
  setPageTitle(intro?.title || "News");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const [news, photosByPostId] = await pageData;
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
  const coachesPromise = siteFetch("/coaches");
  const { blocks, teams } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Coaches");
  setPageTitle(intro?.title || "Coaches");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const coaches = await coachesPromise;
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
  const sponsorsPromise = siteFetch("/sponsors");
  const { blocks } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Sponsors");
  setPageTitle(intro?.title || "Sponsors");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const sponsors = await sponsorsPromise;
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
  const albumsPromise = siteFetch("/albums");
  const photosPromise = albumsPromise.then((albums) =>
    Promise.all(albums.map((album) => siteFetch(`/photos/${encodeURIComponent(album.album_id)}`).catch(() => [])))
  );
  const { blocks } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Photos");
  setPageTitle(intro?.title || "Photos");
  const main = document.getElementById("page-content");
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const albums = await albumsPromise;
  if (!albums.length) {
    main.appendChild(el("p", { class: "empty-state", text: "No photos yet." }));
    return;
  }

  const photosByAlbum = await photosPromise;

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

// A team that hasn't played yet (no parseable streak) gets a plain dash
// rather than a badge.
function streakBadge(streak) {
  const parsed = parseStreak(streak);
  if (!parsed) return el("span", { class: "streak-empty", text: "—" });
  return el("span", {
    class: `streak-badge ${parsed.isWin ? "streak-badge--win" : "streak-badge--loss"}`,
    text: parsed.label,
  });
}

// The full League Standings table (places with ties, highlighted "us"
// row, grouped League/Overall columns, streak badges) for already-sorted
// rows - shared by the Standings page and the Regional Leagues page's
// per-league tables, so both read identically. `usName` is the
// lowercased Logo block title (same "which row is us" matching as the
// Home page standings and the sidebar record box).
function buildStandingsTable(rows, usName) {
  const places = standingsPlaces(rows);
  const usIndex = usName ? rows.findIndex((r) => (r.school || "").toLowerCase() === usName) : -1;

  const th = (text, attrs = {}) => el("th", { ...attrs, text });
  const tbody = el("tbody");
  rows.forEach((row, i) => {
    const { place, tied } = places[i];
    const leagueDiff = formatDiff(row.league_pf, row.league_pa);
    const overallDiff = formatDiff(row.overall_pf, row.overall_pa);
    tbody.appendChild(
      el("tr", i === usIndex ? { class: "standings-row-us" } : {}, [
        el("td", { class: "col-place nums", text: `${tied ? "T" : ""}${place}` }),
        el("td", { class: "col-school" }, [
          el("div", { class: "school-cell" }, [
            el("span", { class: "school-badge", "aria-hidden": "true", style: schoolBadgeStyle(row.school, row), text: schoolInitials(row.school) }),
            row.link
              ? el("a", { href: row.link, target: "_blank", rel: "noopener", text: row.school || "" })
              : el("span", { text: row.school || "" }),
          ]),
        ]),
        el("td", { class: "col-record nums group-start", text: row.overall_record || "0-0" }),
        el("td", { class: "nums col-pct", text: formatPct(row.overall_record) }),
        el("td", { class: "nums col-optional", text: row.overall_pf || "0" }),
        el("td", { class: "nums col-optional", text: row.overall_pa || "0" }),
        el("td", { class: `nums col-diff ${diffClass(overallDiff)}`.trim(), text: overallDiff }),
        el("td", { class: "col-record nums group-start", text: row.league_record || "0-0" }),
        el("td", { class: "nums col-pct", text: formatPct(row.league_record) }),
        el("td", { class: `nums col-diff ${diffClass(leagueDiff)}`.trim(), title: `PF ${row.league_pf || 0} · PA ${row.league_pa || 0}`, text: leagueDiff }),
        el("td", { class: "group-start" }, [streakBadge(row.streak)]),
      ])
    );
  });

  // `data-group` ties each column header to its group-row label, so
  // syncGroupSpans() can shrink a label's colspan when CSS hides some of
  // its columns at phone width (PF/PA, and #/badge/Pct on Regional Leagues).
  const table = el("table", { class: "standings-table standings-table--full" }, [
    el("thead", {}, [
      el("tr", { class: "standings-group-row" }, [
        th("", { colspan: "2", "data-group": "school" }),
        th("Overall", { colspan: "5", class: "group-start", "data-group": "overall" }),
        th("League", { colspan: "3", class: "group-start", "data-group": "league" }),
        th("", { class: "group-start", "data-group": "streak" }),
      ]),
      el("tr", {}, [
        th("#", { class: "col-place", "data-group": "school" }),
        th("School", { class: "col-school", "data-group": "school" }),
        th("W-L", { class: "group-start", "data-group": "overall" }),
        th("Pct", { class: "col-pct", "data-group": "overall" }),
        th("PF", { class: "col-optional", title: "Points for", "data-group": "overall" }),
        th("PA", { class: "col-optional", title: "Points against", "data-group": "overall" }),
        th("Diff", { title: "Points for minus points against", "data-group": "overall" }),
        th("W-L", { class: "group-start", "data-group": "league" }),
        th("Pct", { class: "col-pct", "data-group": "league" }),
        th("Diff", { title: "Points for minus points against", "data-group": "league" }),
        th("Streak", { class: "group-start", "data-group": "streak" }),
      ]),
    ]),
    tbody,
  ]);
  // Callers attach the table synchronously, so it's in the DOM by the
  // next frame (getComputedStyle needs the page's CSS to apply).
  requestAnimationFrame(() => syncGroupSpans(table));
  PHONE_QUERY.addEventListener("change", () => syncGroupSpans(table));
  return el("div", { class: "table-scroll" }, [table]);
}

const PHONE_QUERY = window.matchMedia("(max-width: 720px)");

// A group label's colspan is fixed in markup, but phone-width CSS hides
// some columns (display: none drops them from the table grid) - left
// alone, "Overall" would then stretch over the League columns. Recount
// each group's visible column headers and match the label to them.
function syncGroupSpans(table) {
  const columnHeads = [...table.querySelectorAll("thead tr:last-child th[data-group]")];
  for (const label of table.querySelectorAll("thead tr.standings-group-row th[data-group]")) {
    const visible = columnHeads.filter((h) => h.dataset.group === label.dataset.group && getComputedStyle(h).display !== "none").length;
    label.style.display = visible ? "" : "none";
    if (visible) label.colSpan = visible;
  }
}

async function initStandingsPage() {
  const { blocks, standingsCache: cache } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Standings");
  const logoBlock = findBlockByGenerator(blocks, "Logo");
  setPageTitle(intro?.title || "League Standings");
  const main = document.getElementById("page-content");
  main.appendChild(el("span", { class: "eyebrow", text: `${logoBlock?.league_name || "League"} · ${defaultSeason()} Varsity` }));
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));

  const rows = [...(cache?.rows || [])].sort(compareStandingsRows);
  if (!rows.length) {
    main.appendChild(el("p", { class: "empty-state", text: "Standings aren't available yet." }));
    return;
  }
  main.appendChild(buildStandingsTable(rows, (logoBlock?.title || "").toLowerCase()));

  const footnoteParts = ["Ranked by league record, then overall record."];
  if (cache?.updated_at) {
    footnoteParts.push(
      `Updated ${new Date(cache.updated_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.`
    );
  }
  main.appendChild(el("p", { class: "standings-footnote", text: footnoteParts.join(" ") }));
}

// Regional Leagues - the `rankings` Lambda's cache (see Rankings in
// docs/content-schemas.md): every team in a fixed set of area leagues,
// rated by capped-margin SRS so teams that never play each other
// can still be compared. Three tabs: a Ranking table sortable by any
// column header, one League Standings-style table per league (via
// buildStandingsTable, so those sort/rank exactly like our own league's
// Standings page), and a School Map (buildSchoolMap).
async function initRegionalLeaguesPage() {
  const { blocks } = await initLayout();
  const intro = findBlockByGenerator(blocks, "Regional Leagues");
  const logoBlock = findBlockByGenerator(blocks, "Logo");
  const usName = (logoBlock?.title || "").toLowerCase();
  setPageTitle(intro?.title || "Regional Leagues");
  const main = document.getElementById("page-content");

  const cache = await siteFetch("/rankings").catch(() => null);
  const teams = cache?.teams || [];
  const leagues = cache?.leagues || [];
  main.appendChild(el("span", { class: "eyebrow", text: `${leagues.length} Area Leagues · ${defaultSeason()} Varsity` }));
  if (intro?.body) main.appendChild(el("p", { class: "page-intro", text: intro.body }));
  if (!teams.length) {
    main.appendChild(el("p", { class: "empty-state", text: "Regional leagues aren't available yet." }));
    return;
  }

  const signed = (n, digits = 1) => {
    const v = Number(n) || 0;
    return v > 0 ? `+${v.toFixed(digits)}` : v.toFixed(digits);
  };
  const winPct = (record) => {
    const { wins, losses } = parseRecord(record);
    return wins + losses ? wins / (wins + losses) : -1;
  };
  // A team with no games yet has nothing to rank on - shown as a dash and
  // always sorted to the bottom of a rank column, whichever direction.
  const played = (t) => Number(t.games) > 0;

  // `value` is what a column sorts on; `desc` means its first click sorts
  // high-to-low (ratings), otherwise low-to-high (ranks, names).
  const COLUMNS = [
    { label: "#", title: "SRS rank", cls: "col-place", value: (t) => (played(t) ? Number(t.srs_rank) : Infinity), render: (t) => (played(t) ? String(t.srs_rank) : "—") },
    { label: "School", cls: "col-school", value: (t) => t.name || "", school: true },
    { label: "League", cls: "col-league", value: (t) => t.league_name || "" },
    { label: "W-L", value: (t) => winPct(t.record), desc: true, render: (t) => t.record || "0-0" },
    { label: "Margin", title: "Average point margin per game (each game capped at ±15)", value: (t) => Number(t.avg_margin), desc: true, render: (t) => (played(t) ? signed(t.avg_margin) : "—"), diff: true },
    { label: "SOS", title: "Strength of schedule: average SRS of opponents played", value: (t) => Number(t.sos), desc: true, render: (t) => (played(t) ? signed(t.sos) : "—"), cls: "col-optional" },
    { label: "SRS", title: "Simple Rating System: points better than an average team on a neutral floor", value: (t) => Number(t.srs), desc: true, render: (t) => signed(t.srs), diff: true },
  ];

  const tabs = el("div", { class: "filter-row regional-tabs" });
  // .regional-leagues scopes this page's phone-width column trimming (see
  // site.css) so the Standings page's table keeps its # column and badges.
  const overallPanel = el("div", { class: "regional-leagues" });
  const leaguesPanel = el("div", { class: "regional-leagues" });
  const mapPanel = el("div");
  main.appendChild(tabs);
  main.appendChild(overallPanel);
  main.appendChild(leaguesPanel);
  main.appendChild(mapPanel);

  /* ---- Ranking tab: sortable by any header ---- */
  let sortIndex = 0;
  let sortAsc = true;
  const thead = el("thead");
  const tbody = el("tbody");
  overallPanel.appendChild(
    el("div", { class: "table-scroll" }, [el("table", { class: "standings-table standings-table--full regional-table" }, [thead, tbody])])
  );

  function compareTeams(a, b) {
    const col = COLUMNS[sortIndex];
    const av = col.value(a);
    const bv = col.value(b);
    // Unplayed teams (Infinity) stay last regardless of direction.
    if (av === Infinity || bv === Infinity) return av === bv ? 0 : av === Infinity ? 1 : -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    // SRS rank is the stable tiebreaker for every column.
    return (sortAsc ? cmp : -cmp) || Number(a.srs_rank) - Number(b.srs_rank);
  }

  function paintHeader() {
    thead.innerHTML = "";
    thead.appendChild(
      el(
        "tr",
        {},
        COLUMNS.map((col, i) => {
          const active = i === sortIndex;
          const attrs = {
            class: ["th-sortable", col.cls, active && "th-sorted"].filter(Boolean).join(" "),
            text: col.label + (active ? (sortAsc ? " ▲" : " ▼") : ""),
            "aria-sort": active ? (sortAsc ? "ascending" : "descending") : "none",
          };
          if (col.title) attrs.title = col.title;
          const th = el("th", attrs);
          th.addEventListener("click", () => {
            sortAsc = i === sortIndex ? !sortAsc : !col.desc;
            sortIndex = i;
            paintHeader();
            paintRows();
          });
          return th;
        })
      )
    );
  }

  function paintRows() {
    tbody.innerHTML = "";
    for (const t of [...teams].sort(compareTeams)) {
      const isUs = usName && (t.name || "").toLowerCase() === usName;
      tbody.appendChild(
        el(
          "tr",
          isUs ? { class: "standings-row-us" } : {},
          COLUMNS.map((col) => {
            if (col.school) {
              return el("td", { class: "col-school" }, [
                el("div", { class: "school-cell" }, [
                  el("span", { class: "school-badge", "aria-hidden": "true", style: schoolBadgeStyle(t.name, t), text: schoolInitials(t.name) }),
                  el("a", { href: t.url, target: "_blank", rel: "noopener", text: t.name || "" }),
                ]),
              ]);
            }
            const text = col.render ? col.render(t) : String(col.value(t));
            const cls = [col.cls, col.cls === "col-league" ? "" : "nums", col.diff && played(t) ? diffClass(text) : ""].filter(Boolean).join(" ");
            return el("td", { class: cls, text });
          })
        )
      );
    }
  }

  paintHeader();
  paintRows();
  overallPanel.appendChild(
    el("p", {
      class: "standings-footnote",
      text:
        "SRS rates each team in points better than an average team, from every game's score margin (capped at 15) " +
        "adjusted for opponent strength and home court. " +
        "Early-season ratings move a lot - only a few games are in. Click any column to sort.",
    })
  );

  /* ---- Leagues tab (leagues A-Z) ---- */
  for (const league of [...leagues].sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
    const rows = teams
      .filter((t) => t.league === league.league)
      .map((t) => ({ ...t, school: t.name, link: t.url }))
      .sort(compareStandingsRows);
    if (!rows.length) continue;
    leaguesPanel.appendChild(sectionDivider(`${league.name} League`, [buildStandingsTable(rows, usName)]));
  }
  leaguesPanel.appendChild(el("p", { class: "standings-footnote", text: "Each league ranked by league record, then overall record, as reported by MaxPreps." }));

  /* ---- Tabs (remembered in the URL hash so a link can open either) ---- */
  // The map is built on first view, not up front - Leaflet measures its
  // container when it initializes, and a hidden panel measures 0x0.
  let schoolMap = null;
  // League filter for the School Map: a select in the tab row, right
  // beside the School Map tab, shown only while that tab is open.
  const leagueSelect = el("select", { class: "map-league-select", "aria-label": "Highlight a league on the map" }, [
    el("option", { value: "", text: "All leagues" }),
    ...[...leagues]
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map((l) => el("option", { value: l.league, text: l.name })),
  ]);
  leagueSelect.addEventListener("change", () => schoolMap?.applyFilter(leagueSelect.value || null));
  const TABS = [
    { id: "ranking", label: "Ranking", panel: overallPanel },
    { id: "leagues", label: "Leagues", panel: leaguesPanel },
    {
      id: "map",
      label: "School Map",
      panel: mapPanel,
      onShow: () => {
        if (!schoolMap) {
          schoolMap = buildSchoolMap(mapPanel, teams, usName);
          schoolMap?.applyFilter(leagueSelect.value || null);
        } else {
          schoolMap.map.invalidateSize();
        }
      },
    },
  ];
  function showTab(id) {
    for (const tab of TABS) {
      tab.panel.hidden = tab.id !== id;
      tab.button.classList.toggle("active", tab.id === id);
    }
    leagueSelect.hidden = id !== "map";
    TABS.find((tab) => tab.id === id)?.onShow?.();
  }
  for (const tab of TABS) {
    tab.button = el("button", { type: "button", text: tab.label });
    tab.button.addEventListener("click", () => {
      history.replaceState(null, "", `#${tab.id}`);
      showTab(tab.id);
    });
    tabs.appendChild(tab.button);
  }
  tabs.appendChild(leagueSelect);
  const hashTab = window.location.hash.slice(1);
  showTab(TABS.some((tab) => tab.id === hashTab) ? hashTab : "ranking");

  if (cache.updated_at) {
    main.appendChild(
      el("p", {
        class: "standings-footnote",
        text: `Updated ${new Date(cache.updated_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${cache.game_count || 0} games.`,
      })
    );
  }
}

// Regional Leagues' School Map tab: every tracked school pinned on an
// OpenStreetMap base map (Leaflet, loaded from cdnjs by
// regional-leagues.html only). Coordinates come from the rankings
// Lambda's cached geocode of each school's MaxPreps address. Pins are one
// neutral ink color; choosing a league (the select in the page's tab row,
// via the returned applyFilter) highlights that league's schools in the
// site's bronze accent and dims the rest, rather than ten league colors -
// too many hues to tell apart on a map, and the Classical system is
// single-accent. Our own school always wears the header yellow. Returns
// { map, applyFilter }, or null if Leaflet didn't load.
function buildSchoolMap(container, teams, usName) {
  if (typeof L === "undefined") {
    container.appendChild(el("p", { class: "empty-state", text: "The map couldn't be loaded." }));
    return null;
  }
  const located = teams.filter((t) => t.lat != null && t.lng != null);
  const isUs = (t) => usName && (t.name || "").toLowerCase() === usName;
  const mapEl = el("div", { class: "school-map", role: "region", "aria-label": "Map of schools in the region" });
  const legend = el("div", { class: "school-map-legend" }, [
    el("span", {}, [el("span", { class: "map-key map-key--us" }), el("span", { text: "Our school" })]),
    el("span", {}, [el("span", { class: "map-key map-key--selected" }), el("span", { text: "Selected league" })]),
    el("span", {}, [el("span", { class: "map-key" }), el("span", { text: "Other schools" })]),
  ]);
  container.appendChild(mapEl);
  container.appendChild(legend);

  const map = L.map(mapEl, { scrollWheelZoom: false });
  // Leaflet only renders vector markers once the map has a view, so frame
  // every school (or a default Ventura/West Valley view) before adding any.
  if (located.length) map.fitBounds(L.latLngBounds(located.map((t) => [Number(t.lat), Number(t.lng)])), { padding: [30, 30] });
  else map.setView([34.25, -119.0], 9);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const css = getComputedStyle(document.documentElement);
  const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const INK = color("--color-text", "#201f1d");
  const ACCENT = color("--color-accent", "#b68235");
  const YELLOW = color("--color-yellow-dk", "#e2e231");
  const WHITE = "#ffffff";

  function popupFor(t) {
    const rows = [
      el("strong", { class: "map-popup-name", text: t.name || "" }),
      el("span", { class: "eyebrow", text: `${t.league_name || ""} League` }),
      el("span", { class: "nums", text: `${t.record || "0-0"} · SRS #${t.srs_rank} (${Number(t.srs) > 0 ? "+" : ""}${Number(t.srs).toFixed(1)})` }),
    ];
    if (t.address) rows.push(el("span", { class: "map-popup-address", text: t.address }));
    rows.push(
      el("span", { class: "map-popup-links" }, [
        t.address ? el("a", { href: mapsUrl(t.address), target: "_blank", rel: "noopener", text: "Directions" }) : null,
        el("a", { href: t.url, target: "_blank", rel: "noopener", text: "MaxPreps" }),
      ].filter(Boolean))
    );
    return el("div", { class: "map-popup" }, rows);
  }

  const markers = located.map((t) => {
    const marker = L.circleMarker([Number(t.lat), Number(t.lng)], { weight: 2, opacity: 1 })
      .bindTooltip(t.name || "", { direction: "top", offset: [0, -6] })
      .bindPopup(popupFor(t))
      .addTo(map);
    return { team: t, marker };
  });

  // league = null shows every school at full strength.
  function applyFilter(league) {
    const inView = [];
    for (const { team, marker } of markers) {
      const selected = league && team.league === league;
      const dimmed = league && !selected && !isUs(team);
      if (isUs(team)) {
        marker.setStyle({ radius: 9, fillColor: YELLOW, color: INK, fillOpacity: 1, opacity: 1 });
      } else if (selected) {
        marker.setStyle({ radius: 9, fillColor: ACCENT, color: WHITE, fillOpacity: 1, opacity: 1 });
      } else {
        marker.setStyle({ radius: dimmed ? 5 : 7, fillColor: INK, color: WHITE, fillOpacity: dimmed ? 0.3 : 0.85, opacity: dimmed ? 0.5 : 1 });
      }
      if (selected) marker.bringToFront();
      if (!league || selected) inView.push(marker.getLatLng());
    }
    markers.filter(({ team }) => isUs(team)).forEach(({ marker }) => marker.bringToFront());
    if (inView.length) map.fitBounds(L.latLngBounds(inView), { padding: [30, 30], maxZoom: 12 });
  }

  applyFilter(null);

  const missing = teams.length - located.length;
  if (missing) {
    container.appendChild(
      el("p", { class: "standings-footnote", text: `${missing} school${missing === 1 ? "" : "s"} couldn't be placed on the map.` })
    );
  }
  return { map, applyFilter };
}
