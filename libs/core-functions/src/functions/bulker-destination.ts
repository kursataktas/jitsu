import { JitsuFunction } from "@jitsu/protocols/functions";
import { HTTPError, RetryError } from "@jitsu/functions-lib";
import { AnalyticsServerEvent, DataLayoutType } from "@jitsu/protocols/analytics";

import omit from "lodash/omit";
import { MetricsMeta, createFunctionLogger, JitsuFunctionWrapper } from "./lib";

const TableNameParameter = "JITSU_TABLE_NAME";
export type MappedEvent = {
  event: any;
  table: string;
};
export type DataLayoutImpl<T> = (event: AnalyticsServerEvent) => MappedEvent[] | MappedEvent;

function anonymizeIp(ip: string | undefined) {
  if (!ip) {
    return;
  }
  const parts = ip.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
}

function idToSnakeCase(id: string) {
  return id.replace(/((?<=[a-zA-Z0-9])[A-Z])/g, "_$1").toLowerCase();
}

function toSnakeCase(param: any): any {
  if (Array.isArray(param)) {
    return param.map(toSnakeCase);
  } else if (typeof param === "object" && param !== null) {
    return Object.fromEntries(Object.entries(param).map(([key, value]) => [idToSnakeCase(key), toSnakeCase(value)]));
  } else {
    return param;
  }
}

export function removeUndefined(param: any): any {
  if (Array.isArray(param)) {
    return param.map(removeUndefined);
  } else if (typeof param === "object" && param !== null) {
    return Object.fromEntries(
      Object.entries(param)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, removeUndefined(value)])
    );
  } else {
    return param;
  }
}

export function jitsuLegacy(event: AnalyticsServerEvent): MappedEvent {
  let url: URL | undefined = undefined;
  const urlStr = event.context.page?.url || event.properties?.url;
  try {
    if (urlStr) {
      url = new URL(urlStr as string);
    }
  } catch (e) {}

  const flat = removeUndefined(
    toSnakeCase({
      anon_ip: event.context?.ip ? anonymizeIp(event.context?.ip) : undefined,
      api_key: event.writeKey || "",
      click_id: {},
      doc_encoding: event.context?.page?.encoding || event.properties?.encoding,
      doc_host: url?.hostname,
      doc_path: url?.pathname,
      doc_search: url?.search,
      eventn_ctx_event_id: event.messageId,
      event_type: event.event || event.type,
      local_tz_offset: event.context?.page?.timezoneOffset || event.properties?.timezoneOffset,
      page_title: event.context?.page?.title,
      referer: event.context?.page?.referrer,
      screen_resolution: event.context?.page?.screenResolution,
      source_ip: event.context?.ip,
      src: "jitsu",
      url: (urlStr || "") as string,
      user: {
        id: event.userId,
        email: (event.context?.traits?.email || event.traits?.email || undefined) as string | undefined,
        name: (event.context?.traits?.name || event.traits?.name || undefined) as string | undefined,
        ...omit(
          {
            ...(event.context?.traits || {}),
            ...(event.traits || {}),
          },
          ["email", "name"]
        ),
      },
      user_agent: event.context.userAgent,
      user_language: event.context?.locale,
      utc_time: event.timestamp,
      _timestamp: event.timestamp,
      utm: event.context?.campaign,
      vp_size:
        Math.max(event.context?.screen?.innerWidth || 0) + "x" + Math.max(event.context?.screen?.innerHeight || 0),
      ...(event.type === "track" ? event.properties : {}),
    })
  );
  return { event: flat, table: event[TableNameParameter] ?? "events" };
}

export function segmentLayout(event: AnalyticsServerEvent, singleTable: boolean): MappedEvent[] | MappedEvent {
  let transformed: any;
  //track without properties for segment multi-table layout, because full track event is stored in the table with event name
  let baseTrackFlat: any;
  switch (event.type) {
    case "identify":
      if (singleTable) {
        transformed = {
          ...(event.context || event.traits
            ? {
                context: {
                  ...event.context,
                  traits: omit({ ...event.context?.traits, ...event.traits }, ["groupId"]),
                  groupId: event.traits?.groupId || event.context?.traits?.groupId || undefined,
                },
              }
            : {}),
          ...event.properties,
          ...omit(event, ["context", "properties", "traits", "type", TableNameParameter]),
        };
      } else {
        transformed = {
          ...(event.context ? { context: omit(event.context, "traits") } : {}),
          ...event.properties,
          ...event.context?.traits,
          ...event.traits,
          ...omit(event, ["context", "properties", "traits", "type", TableNameParameter]),
        };
      }
      break;
    case "group":
      if (singleTable) {
        transformed = {
          ...(event.context || event.traits
            ? { context: { ...event.context, group: event.traits, groupId: event.groupId } }
            : {}),
          ...event.properties,
          ...omit(event, ["context", "properties", "traits", "type", "groupId", TableNameParameter]),
        };
      } else {
        transformed = {
          ...(event.context ? { context: omit(event.context, "traits") } : {}),
          ...event.properties,
          ...event.traits,
          ...omit(event, ["context", "properties", "traits", "type", TableNameParameter]),
        };
      }
      break;
    case "track":
      if (singleTable) {
        transformed = {
          ...(event.context || typeof event.properties?.traits === "object"
            ? {
                context: {
                  ...event.context,
                  traits: omit(
                    {
                      ...event.context?.traits,
                      ...(typeof event.properties?.traits === "object" ? event.properties?.traits : {}),
                    },
                    ["groupId"]
                  ),
                  groupId: event.context?.traits?.groupId,
                },
              }
            : {}),
          ...(event.properties ? omit(event.properties, ["traits"]) : {}),
          ...omit(event, ["context", "properties", "type", TableNameParameter]),
        };
      } else {
        baseTrackFlat = toSnakeCase({
          ...omit(event, ["properties", "type", TableNameParameter]),
        });
        transformed = {
          ...(event.properties || {}),
          ...omit(event, ["properties", "type", TableNameParameter]),
        };
      }
      break;
    default:
      if (singleTable) {
        transformed = {
          ...(event.context
            ? {
                context: {
                  ...event.context,
                  traits: omit(event.context?.traits, ["groupId"]),
                  groupId: event.context?.traits?.groupId,
                },
              }
            : {}),
          ...(event.properties || {}),
          ...omit(event, ["context", "properties", TableNameParameter]),
        };
      } else {
        transformed = {
          ...(event.properties || {}),
          ...omit(event, ["properties", TableNameParameter]),
        };
      }
  }
  const flat: Record<string, any> = toSnakeCase(transformed);
  if (event[TableNameParameter]) {
    flat.type = event.type;
    return { event: flat, table: event[TableNameParameter] };
  }
  if (singleTable) {
    flat.type = event.type;
    return { event: flat, table: "events" };
  } else {
    if (event.type === "track" && event.event) {
      return [
        { event: baseTrackFlat, table: "tracks" },
        { event: flat, table: event.event },
      ];
    } else {
      return { event: flat, table: plural(event.type) };
    }
  }
}

function transferAsSnakeCase(target: Record<string, any>, source: Record<string, any>, ...path: string[]) {
  for (const p of path) {
    target = target[p];
  }
  for (const [k, v] of Object.entries(source)) {
    target[idToSnakeCase(k)] = toSnakeCase(v);
  }
}

export function plural(s: string) {
  switch (s) {
    case "identify":
      return "identifies";
    case "page":
      return "pages";
    case "track":
      return "tracks";
    case "group":
      return "groups";
    default:
      return s;
  }
}

export const dataLayouts: Record<DataLayoutType, DataLayoutImpl<any>> = {
  segment: event => segmentLayout(event, false),
  "segment-single-table": event => segmentLayout(event, true),
  "jitsu-legacy": event => jitsuLegacy(event),
  passthrough: event => ({ event: omit(event, TableNameParameter), table: event[TableNameParameter] ?? "events" }),
};

export type BulkerDestinationConfig = {
  bulkerEndpoint: string;
  destinationId: string;
  authToken: string;
  dataLayout?: DataLayoutType;
};

const BulkerDestination: JitsuFunctionWrapper<AnalyticsServerEvent, BulkerDestinationConfig> = (chainCtx, funcCtx) => {
  const log = createFunctionLogger(chainCtx, funcCtx);

  const func: JitsuFunction<AnalyticsServerEvent> = async (event, ctx) => {
    const { bulkerEndpoint, destinationId, authToken, dataLayout = "segment-single-table" } = funcCtx.props;
    try {
      const metricsMeta: Omit<MetricsMeta, "messageId"> = {
        workspaceId: ctx.workspace.id,
        streamId: ctx.source.id,
        destinationId: ctx.destination.id,
        connectionId: ctx.connection.id,
        functionId: "builtin.destination.bulker",
      };
      let adjustedEvent = event;
      const clientIds = event.context?.clientIds;
      const ga4 = clientIds?.ga4;
      if (ga4 && (ga4.sessionIds || ga4["sessions"])) {
        adjustedEvent = {
          ...event,
          context: {
            ...event.context,
            clientIds: {
              ...clientIds,
              ga4: {
                clientId: ga4.clientId,
                sessionIds: ga4["sessions"] ? JSON.stringify(ga4["sessions"]) : JSON.stringify(ga4.sessionIds),
              },
            },
          },
        };
      }
      const events = dataLayouts[dataLayout](adjustedEvent);
      for (const { event, table } of Array.isArray(events) ? events : [events]) {
        const res = await chainCtx.fetch(
          `${bulkerEndpoint}/post/${destinationId}?tableName=${table}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${authToken}`, metricsMeta: JSON.stringify(metricsMeta) },
            body: JSON.stringify(event),
          },
          { log: false }
        );
        if (!res.ok) {
          throw new HTTPError(`HTTP Error: ${res.status} ${res.statusText}`, res.status, await res.text());
        } else {
          log.debug(`HTTP Status: ${res.status} ${res.statusText} Response: ${await res.text()}`);
        }
      }
      return event;
    } catch (e: any) {
      throw new RetryError(e);
    }
  };

  func.displayName = "Bulker Destination";

  func.description = "Synthetic destination to send data to Bulker, jitsu sub-system for storing data in databases";

  return func;
};

export default BulkerDestination;
