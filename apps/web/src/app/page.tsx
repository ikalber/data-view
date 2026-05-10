import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShellClient } from "./app-shell-client";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const email = session.user.email ?? "";
  return <AppShellClient email={email} />;
}
