import {
  API_BASE_PATH
} from "./chunk-TSSXVKCL.js";

// src/client.ts
import createFetchClient from "openapi-fetch";
var InvalidApiUrlError = class extends Error {
  name = "InvalidApiUrlError";
};
function versionedBaseUrl(apiUrl) {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new InvalidApiUrlError("the API URL is not an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidApiUrlError("the API URL must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new InvalidApiUrlError("the API URL must not carry credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new InvalidApiUrlError("the API URL must not carry a query string or a fragment");
  }
  const mount = parsed.pathname.replace(/\/+$/u, "");
  if (mount === API_BASE_PATH || mount.endsWith(API_BASE_PATH)) {
    throw new InvalidApiUrlError(
      `the API URL must not end with ${API_BASE_PATH}: the client adds the version prefix itself`
    );
  }
  return `${parsed.origin}${mount}${API_BASE_PATH}`;
}
function createClient(options) {
  return createFetchClient({
    baseUrl: versionedBaseUrl(options.apiUrl),
    ...options.fetch === void 0 ? {} : { fetch: options.fetch },
    ...options.token === void 0 ? {} : { headers: { Authorization: `Bearer ${options.token}` } }
  });
}
export {
  createClient
};
