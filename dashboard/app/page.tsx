import { redirect } from "next/navigation";

/**
 * The console opens on the queue. There is no dashboard-of-dashboards landing
 * page, because the first question an operator has is always "what is waiting
 * for me".
 */
export default function Home() {
  redirect("/queue");
}
