import { handleRequest } from "./http";

export { BuildDO } from "./build-do";
export { RelayDO } from "./relay-do";

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
