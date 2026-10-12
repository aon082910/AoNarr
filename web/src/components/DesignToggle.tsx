import { useState } from "react";
import Modal from "./Modal.js";
import DesignPicker from "./DesignPicker.js";
import { PaletteIcon } from "./NavIcons.js";

/** Nav-footer/topbar button that opens the design picker in a dialog. Same `className` convention
 * as ThemeToggle/LayoutWidthToggle so it slots into either nav layout. */
export default function DesignToggle({ className = "link-button" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Change design" aria-label="Change design" aria-haspopup="dialog">
        <PaletteIcon />
      </button>
      {open && (
        <Modal title="Choose a design" onClose={() => setOpen(false)} maxWidth={820}>
          <DesignPicker />
        </Modal>
      )}
    </>
  );
}
