/**
 * @file graph.js
 * @description Interactive controller for the SportsDesk & Fantasy402 Phase 6C
 * Surveillance Graph, Pending Bets Tab, 39-Wallet Polymarket & Customer Profile Registry,
 * 4-Week Full-Customer CFB & NBA Parlay/Combo Backtest Tab,
 * and Live Auto-Poller (`./graph-live-feed.json` / `/api/graph-feed`).
 * Externalized to comply with strict Cloudflare Pages CSP (`script-src 'self'`).
 */
(function () {
  // 1. Tab Switching (Topology vs. Pending Bets vs. 39-Wallet Profile Registry vs. 4-Week Parlay Backtest)
  const tabBtns = document.querySelectorAll("[data-tab-target]");
  const tabPanels = document.querySelectorAll("[data-tab-panel]");

  tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const target = btn.getAttribute("data-tab-target");
      tabBtns.forEach(function (b) {
        const active = b.getAttribute("data-tab-target") === target;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      tabPanels.forEach(function (panel) {
        if (panel.getAttribute("data-tab-panel") === target) {
          panel.removeAttribute("hidden");
        } else {
          panel.setAttribute("hidden", "");
        }
      });
    });
  });

  // 2. Collapsible 1Q-4Q & Alt Ring Drawer
  const periodDrawerBtn = document.getElementById("toggle-period-drawer");
  const periodDrawer = document.getElementById("period-drawer-panel");
  if (periodDrawerBtn && periodDrawer) {
    periodDrawerBtn.addEventListener("click", function () {
      const isHidden = periodDrawer.hasAttribute("hidden");
      if (isHidden) {
        periodDrawer.removeAttribute("hidden");
        periodDrawerBtn.setAttribute("aria-expanded", "true");
        periodDrawerBtn.textContent = "Collapse 1Q–4Q & Alt Ring Drawer ▾";
      } else {
        periodDrawer.setAttribute("hidden", "");
        periodDrawerBtn.setAttribute("aria-expanded", "false");
        periodDrawerBtn.textContent = "Expand 1Q–4Q & Alt Ring Drawer ▸";
      }
    });
  }

  // 3. Canonical Integer Hundredths Slider (-50 to +50)
  const deltaSlider = document.getElementById("line-delta-slider");
  const deltaReadout = document.getElementById("line-delta-readout");
  if (deltaSlider && deltaReadout) {
    deltaSlider.addEventListener("input", function () {
      const val = Number(deltaSlider.value);
      const sign = val > 0 ? "+" : "";
      let verdict = "0 (Exact Consensus)";
      let color = "#e2e8f0";
      if (val < 0) {
        verdict = sign + val + " hundredths (F402 Internal Better Line)";
        color = "#22c55e";
      } else if (val > 0) {
        verdict = sign + val + " hundredths (Polymarket Better Line — Layoff Risk!)";
        color = "#ef4444";
      }
      deltaReadout.textContent = verdict;
      deltaReadout.style.color = color;
    });
  }

  // 4. Wallet & Customer Profile Registry Search
  const walletSearch = document.getElementById("wallet-filter-input");
  const walletRows = document.querySelectorAll("#wallet-registry-tbody tr");
  if (walletSearch) {
    walletSearch.addEventListener("input", function () {
      const q = walletSearch.value.trim().toLowerCase();
      walletRows.forEach(function (row) {
        const text = (row.textContent || "").toLowerCase();
        row.style.display = text.includes(q) ? "" : "none";
      });
    });
  }

  // 5. Cluster Overview Filter
  const betFilterBtns = document.querySelectorAll("[data-bet-filter]");
  const betRows = document.querySelectorAll("#open-bets-tbody tr");
  betFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const category = btn.getAttribute("data-bet-filter") || "ALL";
      betFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      betRows.forEach(function (row) {
        const rowCat = row.getAttribute("data-category") || "";
        row.style.display = category === "ALL" || rowCat === category ? "" : "none";
      });
    });
  });

  // 6. Pending Bets Tab Filter & Search
  const pendingFilterBtns = document.querySelectorAll("[data-pending-filter]");
  const pendingSearchInput = document.getElementById("pending-search-input");
  const pendingRows = document.querySelectorAll("#pending-legs-tbody tr");
  let activePendingVenue = "ALL";

  function filterPendingRows() {
    const q = pendingSearchInput ? pendingSearchInput.value.trim().toLowerCase() : "";
    pendingRows.forEach(function (row) {
      const venue = row.getAttribute("data-venue") || "";
      const text = (row.textContent || "").toLowerCase();
      const matchesVenue = activePendingVenue === "ALL" || venue === activePendingVenue;
      const matchesQuery = !q || text.includes(q);
      row.style.display = matchesVenue && matchesQuery ? "" : "none";
    });
  }

  pendingFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activePendingVenue = btn.getAttribute("data-pending-filter") || "ALL";
      pendingFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      filterPendingRows();
    });
  });

  if (pendingSearchInput) {
    pendingSearchInput.addEventListener("input", filterPendingRows);
  }

  // 7. 4-Week Parlay & Combo Backtest Tab Filter & Search (CFB & NBA)
  const btFilterBtns = document.querySelectorAll("[data-bt-filter]");
  const btSearchInput = document.getElementById("bt-customer-search");
  const btCustomerRows = document.querySelectorAll("#bt-customer-tbody tr");
  const btFamilyRows = document.querySelectorAll("#bt-family-tbody tr");
  let activeBtFilter = "ALL";

  function filterBacktestRows() {
    const q = btSearchInput ? btSearchInput.value.trim().toLowerCase() : "";
    btFamilyRows.forEach(function (row) {
      const sport = row.getAttribute("data-sport") || "";
      if (activeBtFilter === "CFB") {
        row.style.display = sport.includes("CFB") ? "" : "none";
      } else if (activeBtFilter === "NBA") {
        row.style.display = sport.includes("NBA") ? "" : "none";
      } else {
        row.style.display = "";
      }
    });

    btCustomerRows.forEach(function (row) {
      const sportDom = row.getAttribute("data-dominant-sport") || "";
      const seg = row.getAttribute("data-segment") || "";
      const text = (row.textContent || "").toLowerCase();
      let matchesFilter = true;
      if (activeBtFilter === "CFB") matchesFilter = sportDom === "CFB";
      else if (activeBtFilter === "NBA") matchesFilter = sportDom === "NBA";
      else if (activeBtFilter === "SHARP") matchesFilter = seg === "SHARP";
      else if (activeBtFilter === "REC") matchesFilter = seg === "REC";

      const matchesQuery = !q || text.includes(q);
      row.style.display = matchesFilter && matchesQuery ? "" : "none";
    });
  }

  btFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeBtFilter = btn.getAttribute("data-bt-filter") || "ALL";
      btFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      filterBacktestRows();
    });
  });

  if (btSearchInput) {
    btSearchInput.addEventListener("input", filterBacktestRows);
  }

  
  // 7b. Watchlist Bet-Ticker by ROT Filter & Search
  const rotFilterBtns = document.querySelectorAll("[data-rot-filter]");
  const rotChannelBtns = document.querySelectorAll("[data-rot-channel]");
  const rotSearchInput = document.getElementById("rot-ticker-search");
  const rotTickerRows = document.querySelectorAll("#rot-ticker-tbody tr");
  let activeRotFilter = "ALL";
  let activeRotChannel = "ALL";

  function filterRotTickerRows() {
    const q = rotSearchInput ? rotSearchInput.value.trim().toLowerCase() : "";
    rotTickerRows.forEach(function (row) {
      const rot = row.getAttribute("data-rot") || "";
      const ch = row.getAttribute("data-channel") || "";
      const text = (row.textContent || "").toLowerCase();
      const matchRot = activeRotFilter === "ALL" || rot === activeRotFilter || (activeRotFilter === "501" && (rot === "501" || rot === "5501"));
      const matchCh = activeRotChannel === "ALL" || ch.includes(activeRotChannel);
      const matchQ = !q || text.includes(q);
      row.style.display = matchRot && matchCh && matchQ ? "" : "none";
    });
  }

  rotFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeRotFilter = btn.getAttribute("data-rot-filter") || "ALL";
      rotFilterBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      filterRotTickerRows();
    });
  });

  rotChannelBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeRotChannel = btn.getAttribute("data-rot-channel") || "ALL";
      rotChannelBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      filterRotTickerRows();
    });
  });

  if (rotSearchInput) {
    rotSearchInput.addEventListener("input", filterRotTickerRows);
  }

  
  // 7c. Per-Office IP-Tracker Cluster Filter in Tab 5
  const officeFilterBtns = document.querySelectorAll("[data-office-filter]");
  const officeRows = document.querySelectorAll("#office-ip-tbody tr");
  officeFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const f = btn.getAttribute("data-office-filter") || "ALL";
      officeFilterBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      officeRows.forEach(function (row) {
        const cls = row.getAttribute("data-office-class") || "";
        const ag = row.getAttribute("data-office-agent") || "";
        if (f === "ALL") row.style.display = "";
        else if (f === "PER_OFFICE") row.style.display = cls.includes("PER_OFFICE") ? "" : "none";
        else if (f === "CROSS_OFFICE") row.style.display = cls.includes("CROSS_OFFICE") ? "" : "none";
        else row.style.display = ag === f ? "" : "none";
      });
    });
  });

  // 7d. 10-Mode Forensic, Risk, Cross-Market & Reconciliation Domain Filter in Tab 6
  const modeDomainBtns = document.querySelectorAll("[data-mode-domain-filter]");
  const modeCatalogRows = document.querySelectorAll("#forensic-modes-catalog-tbody tr");
  modeDomainBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const dom = btn.getAttribute("data-mode-domain-filter") || "ALL";
      modeDomainBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      modeCatalogRows.forEach(function (row) {
        const rowDom = row.getAttribute("data-mode-domain") || "";
        row.style.display = dom === "ALL" || rowDom === dom ? "" : "none";
      });
    });
  });

  // 8. Live Poller Sync (`./graph-live-feed.json` / `/api/graph-feed`) + Relative Age Counter
  const lastUpdatedEl = document.getElementById("live-last-updated-ts");
  const lastUpdatedAgeEl = document.getElementById("live-last-updated-age");
  const pollSeqEl = document.getElementById("live-poll-seq");
  const pollNowBtn = document.getElementById("poll-now-btn");
  const cellSyncStamps = document.querySelectorAll(".live-sync-ts");

  let lastPollEpochMs = Date.now();
  let localPollCount = 1;

  function updateRelativeAge() {
    if (!lastUpdatedAgeEl) return;
    const sec = Math.max(0, Math.floor((Date.now() - lastPollEpochMs) / 1000));
    lastUpdatedAgeEl.textContent = sec + "s ago";
  }

  async function pollLiveFeed() {
    try {
      const res = await fetch("./graph-live-feed.json?t=" + Date.now(), {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.lastUpdatedCdt) {
        lastPollEpochMs = data.pollEpochMs || Date.now();
        localPollCount = Math.max(localPollCount + 1, data.pollSequence || 1);
        if (lastUpdatedEl) {
          lastUpdatedEl.textContent = data.lastUpdatedCdt + " (" + data.lastUpdatedIso.slice(11, 19) + " UTC)";
        }
        if (pollSeqEl) {
          pollSeqEl.textContent = "Poll #" + localPollCount;
        }
        cellSyncStamps.forEach(function (el) {
          el.textContent = data.lastUpdatedCdt;
        });
        updateRelativeAge();
      }
    } catch (_err) {
      const now = new Date();
      lastPollEpochMs = now.getTime();
      if (lastUpdatedEl) {
        lastUpdatedEl.textContent = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
      }
      updateRelativeAge();
    }
  }

  if (pollNowBtn) {
    pollNowBtn.addEventListener("click", function () {
      pollLiveFeed();
    });
  }

  setInterval(updateRelativeAge, 1000);
  setInterval(pollLiveFeed, 15000);
  pollLiveFeed();
})();
