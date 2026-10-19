import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

/**
 * True when dbweb runs as a hosting platform's DB studio (DBWEB_EMBEDDED on
 * the server): the platform owns the connection list, so the UI hides
 * create / edit / delete / bundle / backup actions (the server refuses them).
 */
export function useEmbedded(): boolean {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15_000 });
  return health.data?.embedded === true;
}
