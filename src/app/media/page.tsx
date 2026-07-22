import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/current";
import { listMediaLibrary, mediaQuerySchema } from "@/server/services/media";
import { MediaLibrary } from "./media-library";

export const dynamic = "force-dynamic";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MediaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const raw = await searchParams;
  const query = mediaQuerySchema.parse({
    q: single(raw.q) ?? "",
    gameId: single(raw.gameId) ?? "",
    source: single(raw.source) ?? "",
    page: single(raw.page) ?? "1",
    pageSize: "60"
  });
  const result = await listMediaLibrary(session.userId, query);
  const items = result.items.map((item) => ({
    ...item,
    capturedAt: item.capturedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString()
  }));
  const albums = result.albums.map((album) => ({
    ...album,
    capturedAt: album.capturedAt?.toISOString() ?? null,
    createdAt: album.createdAt.toISOString()
  }));

  return (
    <AppShell username={session.username} active="/media">
      <MediaLibrary
        items={items}
        albums={albums}
        gameOptions={result.gameOptions}
        stats={result.stats}
        total={result.total}
        query={result.query}
      />
    </AppShell>
  );
}
