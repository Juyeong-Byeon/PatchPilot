import { QueryClient } from "@tanstack/react-query";

// One QueryClient per App mount (created via a lazy useState initializer so it is
// never recreated on re-render, and each test render is isolated). `retry: false`
// makes a 401 surface immediately and never retry against an invalid token;
// `refetchOnWindowFocus: false` leaves polling cadence under App's explicit
// refetchInterval control instead of refetching on every focus.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}
