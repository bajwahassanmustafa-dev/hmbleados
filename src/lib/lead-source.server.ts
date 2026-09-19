// Lead source abstraction. Providers live behind this interface so the
// data source can be swapped without touching the UI or the import logic.

export type SourcedBusiness = {
  source: string;
  source_id: string;
  company_name: string;
  industry: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  website: string | null;
  phone: string | null;
  maps_url: string | null;
  rating: number | null;
  review_count: number | null;
  description: string | null;
};

export type LeadSourceStatus = {
  id: string;
  name: string;
  configured: boolean;
  detail: string;
  maxResults: number;
};

export interface LeadSource {
  readonly id: string;
  readonly name: string;
  readonly maxResults: number;
  status(): LeadSourceStatus;
  searchBusinesses(query: string, location: string, limit: number): Promise<SourcedBusiness[]>;
}

export class LeadSourceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LeadSourceError";
  }
}

// ---------------------------------------------------------------------------
// Google Maps Platform (Places API New) via the Lovable connector gateway
// ---------------------------------------------------------------------------

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_maps";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.formattedAddress",
  "places.addressComponents",
  "places.websiteUri",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.editorialSummary",
  "places.businessStatus",
  "nextPageToken",
].join(",");

type AddressComponent = { longText?: string; types?: string[] };
type Place = {
  id: string;
  displayName?: { text?: string };
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  websiteUri?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  editorialSummary?: { text?: string };
  businessStatus?: string;
};

function component(components: AddressComponent[] | undefined, type: string): string | null {
  const c = components?.find((x) => x.types?.includes(type));
  return c?.longText ?? null;
}

class GoogleMapsLeadSource implements LeadSource {
  readonly id = "google_maps";
  readonly name = "Google Maps Platform (Places API)";
  // Places Text Search returns at most 3 pages of 20 results.
  readonly maxResults = 60;

  private creds() {
    const lovableKey = process.env["LOVABLE_API_KEY"];
    const mapsKey = process.env["GOOGLE_MAPS_API_KEY"];
    return { lovableKey, mapsKey };
  }

  status(): LeadSourceStatus {
    const { lovableKey, mapsKey } = this.creds();
    const configured = !!lovableKey && !!mapsKey;
    return {
      id: this.id,
      name: this.name,
      configured,
      detail: configured
        ? "Connected through the Google Maps Platform connector. Searches are billed Google Maps usage; results are capped at 60 per search."
        : "Google Maps Platform connector is not linked to this project. Link it under Connectors to enable business search.",
      maxResults: this.maxResults,
    };
  }

  async searchBusinesses(query: string, location: string, limit: number): Promise<SourcedBusiness[]> {
    const { lovableKey, mapsKey } = this.creds();
    if (!lovableKey || !mapsKey) {
      throw new LeadSourceError("Lead source not configured: Google Maps Platform connector is not linked.");
    }
    const target = Math.max(1, Math.min(limit, this.maxResults));
    const results: SourcedBusiness[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < 3 && results.length < target; page++) {
      const body: Record<string, unknown> = {
        textQuery: `${query} in ${location}`,
        pageSize: Math.min(20, target - results.length),
      };
      if (pageToken) body["pageToken"] = pageToken;

      const res = await fetch(`${GATEWAY_URL}/places/v1/places:searchText`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": mapsKey,
          "Content-Type": "application/json",
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[lead-source] Google Maps request failed [${res.status}]: ${text}`);
        if (res.status === 403) {
          let reason: string | undefined;
          try {
            const details: Array<{ reason?: string }> = JSON.parse(text)?.error?.details ?? [];
            reason = details.find((d) => d.reason)?.reason;
          } catch {
            /* ignore */
          }
          if (reason === "API_KEY_SERVICE_BLOCKED") {
            throw new LeadSourceError(
              "Google Maps key does not allow the Places API (New). Enable it for the connected key.",
              403,
            );
          }
          throw new LeadSourceError(`Google Maps request was denied (403): ${text.slice(0, 300)}`, 403);
        }
        if (res.status === 401) {
          throw new LeadSourceError("Lead source authentication failed. Check the Google Maps connection.", 401);
        }
        if (res.status === 429) {
          throw new LeadSourceError("Google Maps rate limit reached. Try again in a moment.", 429);
        }
        throw new LeadSourceError(`Lead source error [${res.status}]: ${text.slice(0, 300)}`, res.status);
      }

      const data = (await res.json()) as { places?: Place[]; nextPageToken?: string };
      for (const p of data.places ?? []) {
        if (!p.id || !p.displayName?.text) continue;
        if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
        results.push({
          source: this.id,
          source_id: p.id,
          company_name: p.displayName.text,
          industry:
            p.primaryTypeDisplayName?.text ??
            (p.types?.[0] ? p.types[0].replace(/_/g, " ") : null),
          address: p.formattedAddress ?? null,
          city:
            component(p.addressComponents, "locality") ??
            component(p.addressComponents, "administrative_area_level_1"),
          country: component(p.addressComponents, "country"),
          website: p.websiteUri ?? null,
          phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
          maps_url: p.googleMapsUri ?? null,
          rating: typeof p.rating === "number" ? p.rating : null,
          review_count: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
          description: p.editorialSummary?.text ?? null,
        });
        if (results.length >= target) break;
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return results;
  }
}

const googleMaps = new GoogleMapsLeadSource();
const sources: Record<string, LeadSource> = {
  google_maps: googleMaps,
};

export function getLeadSource(id: string = "google_maps"): LeadSource {
  return sources[id] ?? googleMaps;
}

export function listLeadSources(): LeadSourceStatus[] {
  return Object.values(sources).map((s) => s.status());
}
