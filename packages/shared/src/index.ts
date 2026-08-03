export * from "./enums.js";
export * from "./money.js";
export * from "./dates.js";
export * from "./schemas.js";

/** Shape of the JSON error envelope returned by the API. */
export interface ApiError {
  error: string;
  details?: unknown;
}

/** Standard paginated list envelope. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
