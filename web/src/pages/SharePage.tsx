import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

interface SharedItem {
  type: string;
  title: string;
  year: number | null;
  overview: string | null;
  poster_url: string | null;
  status: string;
}

/** Fully public — no login, no API key. Reached by anyone with the /share/:token link an admin
 * generated from a media item's detail page. */
export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [item, setItem] = useState<SharedItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "This link isn't valid");
        setItem(body);
      })
      .catch((err) => setError((err as Error).message));
  }, [token]);

  return (
    <div style={{ maxWidth: 600, margin: "60px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ color: "#4f8cff" }}>AoNarr</h1>
      {error && <p style={{ color: "#e05c5c" }}>{error}</p>}
      {item && (
        <div style={{ display: "flex", gap: 20 }}>
          {item.poster_url && (
            <img src={item.poster_url} alt={item.title} style={{ width: 160, borderRadius: 8 }} />
          )}
          <div>
            <h2 style={{ margin: "0 0 4px" }}>
              {item.title} {item.year ? `(${item.year})` : ""}
            </h2>
            <p style={{ color: "#888", textTransform: "capitalize" }}>{item.type}</p>
            {item.overview && <p>{item.overview}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
