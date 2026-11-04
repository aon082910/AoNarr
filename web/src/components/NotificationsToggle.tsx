import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { isPushSubscribed, subscribeToPush, unsubscribeFromPush } from "../utils/push.js";
import { notify } from "../utils/notify.js";

const NO_CONNECTION_NOTE = "Nothing is sent: no Web push connection is on";
const NO_CONNECTION_TITLE = "Event notifications go out only through a Web push connection, and none is switched on. Add or enable one under Settings > Notifications.";

export default function NotificationsToggle({ className = "link-button" }: { className?: string }) {
  const { auth } = useAuth();
  const [subscribed, setSubscribed] = useState(false);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  // An admin's subscription only receives event notifications through a Web push connection: deleting or switching off
  // that connection leaves the subscription in place, and the button would go on saying "Disable notifications".
  const [noConnection, setNoConnection] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSupported(false);
      return;
    }
    isPushSubscribed().then(setSubscribed);
  }, []);

  useEffect(() => {
    if (!subscribed || !auth.isAdmin) {
      setNoConnection(false);
      return;
    }
    let cancelled = false;
    api
      .get<{ kind: string; enabled: boolean }[]>("/notifications/connections")
      .then((list) => !cancelled && setNoConnection(!list.some((c) => c.kind === "webPush" && c.enabled)))
      .catch(() => !cancelled && setNoConnection(false));
    return () => {
      cancelled = true;
    };
  }, [subscribed, auth.isAdmin]);

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
    <>
      <button type="button" className={className} onClick={toggle} disabled={busy} title={noConnection ? NO_CONNECTION_TITLE : undefined}>
        {subscribed ? "Disable notifications" : "Enable notifications"}
      </button>
      {/* The top bar has no room for a line of text: there the explanation is the button's tooltip. */}
      {noConnection && !className.includes("topbar-action") && (
        <small role="status" title={NO_CONNECTION_TITLE} style={{ color: "var(--muted)", fontSize: "0.7rem", lineHeight: 1.3, padding: "0 12px 4px" }}>
          {NO_CONNECTION_NOTE}
        </small>
      )}
    </>
  );
}
