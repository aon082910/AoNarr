import { useEffect, useState } from "react";
import { isPushSubscribed, subscribeToPush, unsubscribeFromPush } from "../utils/push.js";

export default function NotificationsToggle() {
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
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;

  return (
    <a onClick={busy ? undefined : toggle} style={{ cursor: busy ? "default" : "pointer" }}>
      {subscribed ? "Disable notifications" : "Enable notifications"}
    </a>
  );
}
