import { useEffect, useState } from "react";
import { isPushSubscribed, subscribeToPush, unsubscribeFromPush } from "../utils/push.js";
import { notify } from "../utils/notify.js";

export default function NotificationsToggle({ className = "link-button" }: { className?: string }) {
  const [subscribed, setSubscribed] = useState(false);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSupported(false);
      return;
    }
    isPushSubscribed().then(setSubscribed);
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
      } else {
        await subscribeToPush();
        setSubscribed(true);
      }
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;

  return (
    <button type="button" className={className} onClick={toggle} disabled={busy}>
      {subscribed ? "Disable notifications" : "Enable notifications"}
    </button>
  );
}
