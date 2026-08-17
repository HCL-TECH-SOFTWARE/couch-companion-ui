/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import * as d3 from "d3";
import type { TopologyData } from "./types.js";
import {
  buildTopologyGraph,
  type ReplicationContinuity,
  type TopologyGraphNode,
} from "../../services/topology-model.js";
import { resolveWaColors } from "../../services/wa-color.js";

/** A graph node, plus the position fields `d3.forceSimulation` writes onto it. */
type Node = TopologyGraphNode & d3.SimulationNodeDatum;

interface Link extends d3.SimulationLinkDatum<Node> {
  kind: "hosts" | "replication";
  /** `null` on a `hosts` edge — only a replication is continuous or one-time. */
  continuity: ReplicationContinuity | null;
  bidirectional: boolean;
  /** How many `_replicator` documents the edge stands for; 0 on a `hosts` edge. */
  count: number;
}

/**
 * The design tokens this graph paints with.
 *
 * d3 needs literal colour values, which `resolveWaColors` produces the same way
 * `cca-monaco-editor.ts` does for Monaco's theme API: a hidden probe element resolves the token,
 * then a canvas readback normalizes it to `#rrggbb(aa)`. See `wa-color.ts`.
 *
 * These names are **not** checked by `cca/no-undefined-wa-token`, whatever an earlier version of
 * this comment claimed: that rule matches `var(--wa-…)` inside CSS text, and these are bare token
 * names with no `var(` anywhere near them. A typo would degrade silently to `currentColor`. The
 * set is therefore exported and checked against the theme's declared tokens directly, in
 * `test/no-undefined-wa-token.test.ts`.
 *
 * Colour carries the one thing shape cannot: on a database, **which way documents move** — read
 * from, written to, or both. That leaves servers on `neutral`, with `danger` still reserved for
 * the local server failing to answer. Local against remote is a different question from colour's,
 * and is drawn as a dashed outline instead (see {@link REMOTE_DASH}).
 */
export const GRAPH_TOKENS = {
  /** Any server node. Local against remote is the dashed outline's job, not colour's. */
  server: "--wa-color-neutral-fill-loud",
  /** The local server, when it did not answer. No remote node ever takes this: none is contacted. */
  serverDown: "--wa-color-danger-fill-loud",
  /** A database only ever read from by the documents we can see. */
  dbOutgoing: "--wa-color-brand-fill-loud",
  /** A database only ever written to. */
  dbIncoming: "--wa-color-success-fill-loud",
  /** A database on both sides of some pair of documents. */
  dbBoth: "--wa-color-warning-fill-loud",
  /** Replication lines and the arrowheads — matches the legend swatches in server-topology.ts. */
  link: "--wa-color-neutral-fill-loud",
  /**
   * The server-hosts-database line: quieter than a replication, because it is structure rather
   * than flow, but only one tier quieter — it is the line that says which server a database
   * belongs to, and at `-border-normal` it washed out against the surface.
   */
  hostsLink: "--wa-color-neutral-border-loud",
  /** The ring around a node the local server vouches for: the surface colour, so it reads as a halo. */
  nodeStroke: "--wa-color-surface-default",
  /** The ring around a node that exists only because a local document named it. */
  remoteStroke: "--wa-color-neutral-border-loud",
  /** Server label text. */
  text: "--wa-color-text-normal",
  /** Database label text — quieter, so the server names read as the headings of the picture. */
  dbText: "--wa-color-text-quiet",
} as const;

type GraphColorKey = keyof typeof GRAPH_TOKENS;

/**
 * How a node that was never contacted is drawn: dashed outline, washed-out fill.
 *
 * A remote node is a *hypothesis*. It is on the graph because a local `_replicator` document names
 * it, and spec D10 forbids asking whether it is really there — a `create_target` document
 * routinely names one that does not exist yet. "Asserted, not observed" has to be said without
 * spending a colour, since colour is fully committed to direction; a dash alone turned out to read
 * as a jagged edge rather than as a dashed one at this radius, so the fill fades too.
 */
const REMOTE_DASH = "4 3";
const REMOTE_FILL_OPACITY = 0.55;

/**
 * Resolves {@link GRAPH_TOKENS} to concrete colours. A token that fails to resolve (no 2D canvas
 * — a test environment, not a real browser) falls back to `currentColor` rather than a made-up
 * hex value, so the element still paints something visible instead of going transparent/black.
 */
function resolveGraphColors(): Record<GraphColorKey, string> {
  const resolved = resolveWaColors(Object.values(GRAPH_TOKENS));
  const colors = {} as Record<GraphColorKey, string>;
  for (const key of Object.keys(GRAPH_TOKENS) as GraphColorKey[]) {
    colors[key] = resolved[GRAPH_TOKENS[key]] ?? "currentColor";
  }
  return colors;
}

/**
 * Server node size — the *area* in px² that `d3.symbol` takes, not a radius.
 *
 * `symbolWye` at area A reaches `1.38 * sqrt(A / 3.43)` from its centre, so 700 puts its tips
 * ~20px out with ~14px-wide arms: the same footprint the r=20 circle had when servers were the
 * only nodes on this graph, and twice {@link DATABASE_RADIUS} so the two never read as one another.
 */
const SERVER_SYMBOL_SIZE = 700;

/** How far a server node reaches from its centre, at {@link SERVER_SYMBOL_SIZE}. */
const SERVER_REACH = 20;

/** Database node radius. */
const DATABASE_RADIUS = 10;

/**
 * The `d` of a server node, as a three-armed `d3.symbolWye` centred on the origin.
 *
 * A shape rather than a glyph, and the wye rather than a circle, because a server is a *junction*:
 * the picture's whole point is that databases hang off it, and the wye's arms say so at a glance
 * where a second circle would just be a bigger dot. Exported so the legend in `server-topology.ts`
 * draws the identical path at swatch size instead of approximating it in CSS — a legend that
 * disagrees with the graph is worse than no legend.
 *
 * A Font Awesome glyph was considered and rejected: inlining one needs either a `fetch` (which
 * this app's layering rules forbid outside a service) or an `<image href>`, which cannot be
 * recoloured — and this node has three colours.
 */
export function serverSymbolPath(size: number = SERVER_SYMBOL_SIZE): string {
  return d3.symbol(d3.symbolWye, size)() ?? "";
}

/** How a database's direction reads in prose, for its `<title>`. */
const DIRECTION_TITLE = {
  outgoing: "replicated from",
  incoming: "replicated to",
  both: "replicated both ways",
} as const;

/**
 * The `<title>` of a node: what it is, which server it lives on, and which way it replicates.
 *
 * The server matters because the same database name routinely appears on both ends of a
 * replication, and the two nodes would otherwise be indistinguishable to anyone not reading
 * colour. The direction is the colour said in words, for the same reason.
 */
function nodeTitle(serverNames: Map<string, string>): (d: Node) => string {
  return (d) => {
    if (d.kind === "database") {
      const server = serverNames.get(d.serverId) ?? d.serverId;
      const suffix = d.serverKind === "remote" ? " (not contacted)" : "";
      return `Database ${d.label} on ${server}${suffix} — ${DIRECTION_TITLE[d.direction]}`;
    }
    return d.serverKind === "remote"
      ? `Remote endpoint ${d.label} (not contacted)`
      : `Local server ${d.label}${d.reachable ? "" : " (unreachable)"}`;
  };
}

/** The `<title>` of a replication edge, which is where its document count is readable. */
function linkTitle(d: Link): string {
  if (d.kind === "hosts") return "";
  const arrow = d.bidirectional ? "both ways" : "one way";
  const documents = d.count === 1 ? "1 document" : `${d.count} documents`;
  return `Replication, ${arrow}: ${documents}, ${d.continuity}`;
}

/**
 * The fill for a node.
 *
 * A database is coloured by direction and never by reachability: it has none of its own — spec D10
 * forbids contacting anything, and "the local server answered" says nothing about one database on
 * it — so painting one red would claim knowledge this app does not have.
 */
function nodeFill(colors: Record<GraphColorKey, string>, d: Node): string {
  if (d.kind === "server") {
    return d.serverKind === "local" && !d.reachable
      ? colors.serverDown
      : colors.server;
  }
  if (d.direction === "both") return colors.dbBoth;
  return d.direction === "outgoing" ? colors.dbOutgoing : colors.dbIncoming;
}

/**
 * Draws the topology as `server — databases ↔ databases — server` (#43).
 *
 * Everything about *what* is on the graph is decided by `buildTopologyGraph`, which is pure and
 * tested without a DOM; this function only turns that value into SVG. It is the whole of the
 * change #43 asked for: the database names were already in the model and were being discarded
 * here, which drew every replication between one pair of servers as the same single line.
 */
export function renderTopology(container: HTMLElement, data: TopologyData) {
  // Clear previous
  d3.select(container).selectAll("*").remove();

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 500;
  const colors = resolveGraphColors();

  const svg = d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .style("cursor", "grab");

  // Zoom + pan
  const zoomLayer = svg.append("g").attr("class", "zoom-layer");

  svg.call(
    d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on("zoom", (event) => {
        zoomLayer.attr("transform", event.transform);
      }),
  );

  const graph = buildTopologyGraph(data);
  const serverNames = new Map(data.servers.map((s) => [s.id, s.name]));

  // Shallow copies, because `forceSimulation` writes x/y/vx/vy onto the objects it is handed and
  // the model's return value has to stay the pure value it was.
  const nodes: Node[] = graph.nodes.map((n) => ({ ...n }));

  const toLink = (edge: (typeof graph.edges)[number]): Link =>
    edge.kind === "hosts"
      ? { ...edge, continuity: null, bidirectional: false, count: 0 }
      : {
          source: edge.source,
          target: edge.target,
          kind: edge.kind,
          continuity: edge.continuity,
          bidirectional: edge.bidirectional,
          count: edge.count,
        };

  // A replication whose two endpoints are the same database cannot be drawn as a straight line —
  // it would have zero length and disappear, which is what happened before #43 made databases
  // nodes at all. It gets a looping path of its own instead; the rest stay lines.
  const isSelfLoop = (edge: (typeof graph.edges)[number]) =>
    edge.kind === "replication" && edge.source === edge.target;

  // Structure first, flow second: SVG paints in document order, so listing the quiet `hosts`
  // edges ahead of the replications keeps a replication line from disappearing under one.
  const links: Link[] = [
    ...graph.edges.filter((e) => e.kind === "hosts").map(toLink),
    ...graph.edges
      .filter((e) => e.kind === "replication" && !isSelfLoop(e))
      .map(toLink),
  ];
  const selfLinks: Link[] = graph.edges.filter(isSelfLoop).map(toLink);

  // Arrow marker, on replication edges only — a server does not "flow" into its databases.
  // `userSpaceOnUse` pins the head to a fixed 8px: the default (`strokeWidth`) would draw the
  // continuous arrow at twice the size of the one-time one and land both in the wrong place,
  // since `refX` is then measured in stroke widths too. `auto-start-reverse` lets the one marker
  // serve `marker-start` as well, which is how a both-ways replication gets its second head.
  zoomLayer
    .append("defs")
    .append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -4 8 8")
    // Tip (x=8) pulled back clear of the target database's circle and its ring. A replication
    // whose target is a *server* node — an endpoint that named no database — has its head overlap
    // the larger wye; that is the degenerate document, not the case worth tuning for.
    .attr("refX", 8 + DATABASE_RADIUS + 2)
    .attr("refY", 0)
    .attr("markerWidth", 8)
    .attr("markerHeight", 8)
    .attr("markerUnits", "userSpaceOnUse")
    .attr("orient", "auto-start-reverse")
    .append("path")
    .attr("d", "M0,-4L8,0L0,4")
    .attr("fill", colors.link);

  // The same head for a self-loop, whose path already ends on the node's outline, so it needs no
  // pulling back at all.
  zoomLayer
    .select("defs")
    .append("marker")
    .attr("id", "arrow-tight")
    .attr("viewBox", "0 -4 8 8")
    .attr("refX", 8)
    .attr("refY", 0)
    .attr("markerWidth", 8)
    .attr("markerHeight", 8)
    .attr("markerUnits", "userSpaceOnUse")
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-4L8,0L0,4")
    .attr("fill", colors.link);

  // Simulation. A database sits close to the server that hosts it and far from the database it
  // replicates with, so the clusters read as "this server's databases" rather than as one mesh;
  // `forceCollide` then keeps labelled nodes from stacking, which matters far more now that a
  // busy `_replicator` puts a dozen nodes on screen instead of two.
  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink<Node, Link>(links)
        .id((d) => d.id)
        .distance((l) => (l.kind === "hosts" ? 80 : 180)),
    )
    .force("charge", d3.forceManyBody().strength(-400))
    .force(
      "collide",
      d3.forceCollide<Node>((d) => (d.kind === "server" ? 36 : 24)),
    )
    .force("center", d3.forceCenter(width / 2, height / 2));

  // Continuity is drawn compositionally, so an aggregated edge needs no third line style: width 2
  // means "at least one continuous document", a dash means "at least one one-time", and a mixed
  // edge therefore reads as both at once.
  const linkStroke = (d: Link) =>
    d.kind === "hosts" ? colors.hostsLink : colors.link;
  const linkWidth = (d: Link) =>
    d.kind === "hosts" || d.continuity === "one-time" ? 1 : 2;
  const linkDash = (d: Link) =>
    d.kind === "replication" && d.continuity !== "continuous" ? "4 2" : null;

  // Links
  const link = zoomLayer
    .append("g")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", (d) => `edge edge-${d.kind}`)
    .attr("stroke", linkStroke)
    .attr("stroke-width", linkWidth)
    .attr("stroke-dasharray", linkDash)
    .attr("marker-end", (d) =>
      d.kind === "replication" ? "url(#arrow)" : null,
    )
    // The `<->` of the issue title: one edge with a head at each end, rather than two arcs that
    // lie on top of one another.
    .attr("marker-start", (d) => (d.bidirectional ? "url(#arrow)" : null));
  link
    .filter((d) => d.kind === "replication")
    .append("title")
    .text(linkTitle);

  // Self-loops, as a path because a line between one point and itself has nothing to draw.
  const selfLink = zoomLayer
    .append("g")
    .selectAll("path")
    .data(selfLinks)
    .join("path")
    .attr("class", "edge edge-replication edge-self")
    .attr("fill", "none")
    .attr("stroke", linkStroke)
    .attr("stroke-width", linkWidth)
    .attr("stroke-dasharray", linkDash)
    .attr("marker-end", "url(#arrow-tight)");
  selfLink.append("title").text(linkTitle);

  // Nodes
  const node = zoomLayer
    .append("g")
    .selectAll<SVGGElement, Node>("g")
    .data(nodes)
    .join("g")
    .attr("class", (d) => `node node-${d.kind}`)
    .call(
      d3
        .drag<SVGGElement, Node>()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }),
    );

  // A ring in the surface colour reads as a halo, so a line passing behind a node does not appear
  // to cut through it. A node that was never contacted trades the halo for a dashed outline.
  const outlineStroke = (d: Node) =>
    d.serverKind === "remote" ? colors.remoteStroke : colors.nodeStroke;
  const outlineDash = (d: Node) =>
    d.serverKind === "remote" ? REMOTE_DASH : null;
  const fillOpacity = (d: Node) =>
    d.serverKind === "remote" ? REMOTE_FILL_OPACITY : null;

  // A server is a hub with things hanging off it, so it is drawn as a hub: `symbolWye`.
  node
    .filter((d) => d.kind === "server")
    .append("path")
    .attr("d", serverSymbolPath())
    .attr("fill", (d) => nodeFill(colors, d))
    .attr("fill-opacity", fillOpacity)
    .attr("stroke", outlineStroke)
    .attr("stroke-dasharray", outlineDash)
    .attr("stroke-width", 2);

  // A database stays a circle: at this size the only reliable difference between two symbols is
  // their silhouette, and "three arms" against "round" survives being small far better than any
  // pair of polygons would.
  node
    .filter((d) => d.kind === "database")
    .append("circle")
    .attr("r", DATABASE_RADIUS)
    .attr("fill", (d) => nodeFill(colors, d))
    .attr("fill-opacity", fillOpacity)
    .attr("stroke", outlineStroke)
    .attr("stroke-dasharray", outlineDash)
    .attr("stroke-width", 2);

  // Says in words what shape and colour say in pixels, for a hover and for a screen reader.
  node.append("title").text(nodeTitle(serverNames));

  node
    .append("text")
    .text((d) => d.label)
    .attr("dy", (d) => (d.kind === "server" ? 34 : 24))
    .attr("text-anchor", "middle")
    .attr("font-size", "12px")
    .attr("fill", (d) => (d.kind === "server" ? colors.text : colors.dbText));

  // Tick
  simulation.on("tick", () => {
    link
      .attr("x1", (d: any) => d.source.x)
      .attr("y1", (d: any) => d.source.y)
      .attr("x2", (d: any) => d.target.x)
      .attr("y2", (d: any) => d.target.y);
    selfLink.attr("d", (d: any) => selfLoopPath(d.source));
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });
}

/**
 * A loop leaving the top of a node and coming back to it, for a replication whose source and
 * target are the same database.
 *
 * A cubic with both control points thrown wide of a shared start and end point is the standard way
 * to draw one; the ends sit on the node's own outline so the arrowhead lands on it. CouchDB will
 * not run such a replication, which is precisely why it is drawn rather than suppressed — before
 * databases were nodes it was a zero-length line, i.e. invisible.
 */
function selfLoopPath(d: Node): string {
  const x = d.x ?? 0;
  const y = d.y ?? 0;
  const radius = d.kind === "server" ? SERVER_REACH : DATABASE_RADIUS;
  const spread = radius * 3;
  return (
    `M${x - 8},${y - radius} ` +
    `C${x - spread},${y - spread * 1.4} ${x + spread},${y - spread * 1.4} ${x + 8},${y - radius}`
  );
}
