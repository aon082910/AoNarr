import type { Quality, QualityProfile } from "../types.js";
import { allowedInProfileOrder, moveWithin } from "../utils/qualityOrder.js";
import { ArrowDownIcon, ArrowUpIcon } from "./ActionIcons.js";

/**
 * The order one quality profile ranks its allowed qualities in, worst to best. A profile with no order of its own ranks
 * by the Qualities list (so reordering that list reorders every such profile); moving a quality here gives the profile an
 * order of its own, which the search, the upgrade check and the cutoff all follow. "Use the default order" hands it back
 * to the Qualities list.
 */
export default function QualityOrderEditor({
  profile,
  qualities,
  onSave,
}: {
  profile: QualityProfile;
  qualities: Quality[];
  /** Saves the order (worst to best), or null for the default order. */
  onSave: (order: string[] | null) => void;
}) {
  const names = allowedInProfileOrder(profile, qualities);
  const custom = !!profile.qualityOrder && profile.qualityOrder.length > 0;
  const headingId = `settings-quality-order-${profile.id}`;

  function move(index: number, direction: -1 | 1) {
    const next = moveWithin(names, index, direction);
    if (next) onSave(next);
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <label id={headingId}>Order of the allowed qualities (worst to best)</label>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", margin: "0 0 6px" }}>
        {custom
          ? "This profile ranks its qualities in this order: a quality lower in the list is an upgrade to the ones above it, and the cutoff is read in it."
          : "This profile ranks its qualities as the Qualities list does. Move one to give the profile an order of its own, for example WEB-DL above Blu-ray."}
      </p>
      <ol aria-labelledby={headingId} style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {names.map((name, index) => (
          <li key={name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.85rem", padding: "1px 0" }}>
            <span style={{ width: "1.6em", textAlign: "right", color: "var(--muted)" }}>{index + 1}</span>
            <span style={{ flex: 1 }}>{name}</span>
            <button
              type="button"
              className="icon-button"
              disabled={index === 0}
              onClick={() => move(index, -1)}
              title={`Move ${name} up`}
              aria-label={`Move ${name} up, towards the worst`}
            >
              <ArrowUpIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={index === names.length - 1}
              onClick={() => move(index, 1)}
              title={`Move ${name} down`}
              aria-label={`Move ${name} down, towards the best`}
            >
              <ArrowDownIcon />
            </button>
          </li>
        ))}
      </ol>
      {custom && (
        <button type="button" style={{ marginTop: 6 }} onClick={() => onSave(null)}>
          Use the default order
        </button>
      )}
    </div>
  );
}
