import { useState } from "react";

// Subscribe to the study plan from a calendar app on this computer
// (server/src/scheduleFeed.js, GET /api/schedule/feed.ics). Nothing to
// load and nothing stored: the link is this page's own address, so it's
// right whichever port or loopback name Athena was opened on.

/** The feed's webcal:// link for the page Athena is open on. */
export function feedLink(host: string = window.location.host): string {
  return `webcal://${host}/api/schedule/feed.ics`;
}

export function CalendarSubscribe() {
  const link = feedLink();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <details className="canvas-import calendar-subscribe">
      <summary>Show this plan in your calendar app</summary>
      <div className="canvas-import-body">
        <p className="canvas-import-hint">
          Subscribe once and each day's topics appear as an all-day event that keeps up with the plan, including
          anything you move, delete or mark done. It works with calendar apps on this computer while Athena is
          running; online calendars like Google Calendar can't reach it, so your topics stay on this computer.
        </p>
        <label className="canvas-connect-field">
          Calendar link
          <input type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <div className="canvas-import-actions">
          <a href={link}>
            Open in calendar app
          </a>
          <button type="button" onClick={copyLink}>
            Copy link
          </button>
          <span role="status" className="canvas-import-hint">
            {copy === "copied" && "Copied."}
            {copy === "failed" && "Couldn't copy. Select the link above and copy it."}
          </span>
        </div>
        <p className="canvas-import-hint">
          Apple Calendar: File, New Calendar Subscription, paste the link, then set Location to <strong>On My Mac</strong>{" "}
          (an iCloud location can't reach Athena). Other apps: look for an option to subscribe to a calendar by its link,
          and keep it on this computer rather than in an online account.
        </p>
      </div>
    </details>
  );
}
