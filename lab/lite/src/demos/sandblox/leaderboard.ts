/**
 * Leaderboard — compact player-list overlay, purely for atmosphere.
 *
 * Static panel in the top-right: a header bar and one row with a generated
 * player name and score. Styling follows the toolbar's translucent dark panels;
 * like the toolbar, all CSS is injected and the panel never takes focus.
 */

const CSS = `
.sandblox-leaderboard {
    position: fixed;
    top: 5px;
    right: 5px;
    width: 170px;
    z-index: 1000;
    user-select: none;
    -webkit-user-select: none;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: rgba(220, 220, 220, 1);
}

.sandblox-leaderboard-header,
.sandblox-leaderboard-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 8px;
}

.sandblox-leaderboard-header {
    background: rgba(40, 40, 40, 0.7);
    color: rgba(200, 200, 200, 1);
    font-weight: 600;
}

.sandblox-leaderboard-row {
    background: rgba(60, 60, 60, 0.6);
}

@media (max-width: 480px) {
    .sandblox-leaderboard {
        width: 140px;
        font-size: 12px;
    }
}
`;

/** Create the static leaderboard. Returns the generated player name (for tests). */
export function createLeaderboard(): string {
    const playerName = `Builder ${1000 + Math.floor(Math.random() * 9000)}`;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.className = "sandblox-leaderboard";
    root.setAttribute("aria-label", "Player list");

    const header = document.createElement("div");
    header.className = "sandblox-leaderboard-header";
    header.innerHTML = "<span>Player</span><span>Score</span>";

    const row = document.createElement("div");
    row.className = "sandblox-leaderboard-row";
    const name = document.createElement("span");
    name.textContent = playerName;
    const score = document.createElement("span");
    score.textContent = "0";
    row.append(name, score);

    root.append(header, row);
    document.body.appendChild(root);
    return playerName;
}
