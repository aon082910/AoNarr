import { DESIGNS, setDesign, useDesign, type DesignId } from "../designs/design.js";

/** Mini mock of one design, drawn with that design's own tokens (designs/<id>.css scopes them to
 * `[data-design-preview]` as well as the root, so this picks up the live light/dark theme too). */
function Swatch({ id }: { id: DesignId }) {
  return (
    <div className="design-swatch" data-design-preview={id} aria-hidden="true">
      <div className="design-swatch-side">
        <i />
        <i className="on" />
        <i />
        <i />
      </div>
      <div className="design-swatch-main">
        <b className="design-swatch-title" />
        <div className="design-swatch-posters">
          <span className="p1"><em className="ok" /></span>
          <span className="p2"><em className="bad" /></span>
          <span className="p3"><em className="ok" /></span>
        </div>
        <u className="design-swatch-btn" />
      </div>
    </div>
  );
}

/** Radio group of every available design — Classic (the original look) plus the six redesigns.
 * Native radio inputs, so arrow keys / focus / screen-reader semantics come for free. */
export default function DesignPicker() {
  const current = useDesign();
  return (
    <div>
      <div className="design-grid" role="radiogroup" aria-label="Interface design">
        {DESIGNS.map((d) => (
          <label key={d.id} className={`design-option${current === d.id ? " selected" : ""}`}>
            <input
              type="radio"
              name="aonarr-design"
              className="design-radio"
              checked={current === d.id}
              onChange={() => setDesign(d.id)}
            />
            <Swatch id={d.id} />
            <span className="design-name">
              {d.name}
              {current === d.id && <span className="design-active"> · Active</span>}
            </span>
            <span className="design-tagline">{d.tagline}</span>
          </label>
        ))}
      </div>
      <p className="design-note">
        Applies instantly and is remembered in this browser only. Every design supports both light and dark — use the theme
        button to switch. Classic always stays available.
      </p>
    </div>
  );
}
