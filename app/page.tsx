import { Dashboard } from "@/components/dashboard";
import { getDashboardData } from "@/lib/db";
import { cookies } from "next/headers";
import { isAdminToken, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

type HomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const requestedTheme = firstParam(params.theme);

  return (
    <Dashboard
      initialData={getDashboardData(isAdminToken((await cookies()).get(SESSION_COOKIE)?.value))}
      embedded={firstParam(params.ui_mode) === "embedded"}
      requestedTheme={requestedTheme === "dark" || requestedTheme === "light" ? requestedTheme : null}
    />
  );
}
