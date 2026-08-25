import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.js";

interface PersonCredit {
  tmdbId: number;
  title: string;
  year: number | null;
  character: string | null;
  posterUrl: string | null;
  mediaType: "movie" | "series";
  libraryMediaItemId: number | null;
}

interface PersonDetails {
  name: string;
  biography: string | null;
  photoUrl: string | null;
  credits: PersonCredit[];
}

export default function Person() {
  const { tmdbId } = useParams();
  const navigate = useNavigate();
  const [person, setPerson] = useState<PersonDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPerson(null);
    setError(null);
    api
      .get<PersonDetails>(`/people/${tmdbId}`)
      .then(setPerson)
      .catch((e) => setError((e as Error).message));
  }, [tmdbId]);

  if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!person) return <p className="empty">Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", gap: 20, marginBottom: 16 }}>
        <div
          className="poster"
          style={{
            width: 150,
            height: 200,
            flexShrink: 0,
            // Same fix as the Media Detail page's cast row: .card .poster's background-size: cover
            // never applies here (no .card ancestor), so without this the photo rendered at native
            // resolution anchored top-left — a small zoomed-in crop instead of the whole photo.
            ...(person.photoUrl
              ? { backgroundImage: `url(${person.photoUrl})`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
              : {}),
          }}
        >
          {!person.photoUrl && "No photo"}
        </div>
        <div>
          <h1>{person.name}</h1>
          {person.biography && <p style={{ color: "var(--muted)", maxWidth: 700 }}>{person.biography}</p>}
        </div>
      </div>

      <h2>Filmography</h2>
      {person.credits.length === 0 && <p className="empty">No credits found.</p>}
      <div className="grid">
        {person.credits.map((c, idx) => (
          <div
            key={idx}
            className="card"
            onClick={() => c.libraryMediaItemId && navigate(`/media/${c.libraryMediaItemId}`)}
            style={{ cursor: c.libraryMediaItemId ? "pointer" : "default", opacity: c.libraryMediaItemId ? 1 : 0.7 }}
          >
            <div className="poster" style={c.posterUrl ? { backgroundImage: `url(${c.posterUrl})` } : undefined}>
              {!c.posterUrl && "No poster"}
            </div>
            <div className="meta">
              <div className="title">{c.title}</div>
              <div className="sub">
                {c.year ?? ""} · {c.mediaType === "movie" ? "Movie" : "TV"}
                {c.character ? ` · as ${c.character}` : ""}
              </div>
              {c.libraryMediaItemId ? (
                <span className="badge ok" style={{ marginTop: 4, display: "inline-block" }}>
                  In library
                </span>
              ) : (
                <span className="badge" style={{ marginTop: 4, display: "inline-block" }}>
                  Not in library
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
