import { Service } from "encore.dev/service";

/**
 * Read-only aggregation of campaign statistics. Owns no tables — it reads
 * across the other services' tables through their APIs and through
 * read-only queries.
 */
export default new Service("metrics");
