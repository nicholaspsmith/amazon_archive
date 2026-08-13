import { handleRequest } from './handler.js';

export default {
  fetch: (request, env) => handleRequest(request, env),
};
