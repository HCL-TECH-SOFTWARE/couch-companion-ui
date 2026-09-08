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

/**
 * The demo CouchDB that every walkthrough screenshot is taken against.
 *
 * WHY THIS IS DETERMINISTIC. These documents end up as pixels in PNGs that are
 * committed to the repository. If the data moved between runs — a random total,
 * `new Date()` anywhere, object keys in hash order — then re-capturing one
 * screenshot would rewrite every other one too, and every docs change would
 * arrive as a multi-megabyte binary diff nobody can review. So: fixed strings,
 * fixed dates, a seeded PRNG, and insertion in a fixed order. Nothing here may
 * read the clock or `Math.random`.
 *
 * The scenario is a small online retailer, chosen because it needs no
 * explaining to a reader who is here to learn CouchDB rather than the domain:
 * customers place orders for products. That is enough shape to demonstrate
 * documents, views, Mango queries, roles and replication without a legend.
 */

/** Deterministic 32-bit LCG. Same sequence on every machine, every run. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

export const DB = {
  customers: 'customers',
  orders: 'orders',
  products: 'products',
  archive: 'orders-archive'
};

const CATEGORIES = ['Seating', 'Tables', 'Lighting', 'Storage', 'Textiles'];

const PRODUCTS = [
  ['chesterfield-2seat', 'Chesterfield 2-Seater', 'Seating', 1249.0, 12],
  ['reading-armchair', 'Reading Armchair', 'Seating', 689.0, 31],
  ['ottoman-walnut', 'Walnut Ottoman', 'Seating', 214.5, 44],
  ['dining-oak-180', 'Oak Dining Table 180cm', 'Tables', 1580.0, 7],
  ['side-table-marble', 'Marble Side Table', 'Tables', 329.0, 26],
  ['desk-standing-el', 'Standing Desk, Electric', 'Tables', 940.0, 15],
  ['floor-lamp-arc', 'Arc Floor Lamp', 'Lighting', 275.0, 38],
  ['pendant-brass-3', 'Brass Pendant, 3-Light', 'Lighting', 412.0, 19],
  ['shelf-ladder-oak', 'Oak Ladder Shelf', 'Storage', 358.0, 23],
  ['sideboard-teak', 'Teak Sideboard', 'Storage', 1120.0, 9],
  ['rug-kilim-200', 'Kilim Rug 200x300', 'Textiles', 486.0, 17],
  ['throw-lambswool', 'Lambswool Throw', 'Textiles', 89.5, 62]
];

const PEOPLE = [
  ['Ana Ferreira', 'Lisbon', 'PT'],
  ['Bjorn Hald', 'Aarhus', 'DK'],
  ['Chidi Okonkwo', 'Lagos', 'NG'],
  ['Dagmar Roth', 'Leipzig', 'DE'],
  ['Elena Rossi', 'Bologna', 'IT'],
  ['Farid Haddad', 'Beirut', 'LB'],
  ['Grace Okoye', 'Abuja', 'NG'],
  ['Hana Kowalska', 'Krakow', 'PL'],
  ['Ines Moreau', 'Lyon', 'FR'],
  ['Jonas Berg', 'Uppsala', 'SE'],
  ['Kiran Nair', 'Kochi', 'IN'],
  ['Lucia Marino', 'Naples', 'IT'],
  ['Mateo Silva', 'Porto', 'PT'],
  ['Nadia Aziz', 'Tunis', 'TN'],
  ['Oskar Nowak', 'Gdansk', 'PL'],
  ['Petra Vogel', 'Graz', 'AT'],
  ['Quentin Roy', 'Nantes', 'FR'],
  ['Rina Tanaka', 'Sendai', 'JP'],
  ['Sofia Lindqvist', 'Malmo', 'SE'],
  ['Tomas Novak', 'Brno', 'CZ'],
  ['Ulla Virtanen', 'Tampere', 'FI'],
  ['Viktor Ilic', 'Novi Sad', 'RS'],
  ['Wanjiru Kamau', 'Nakuru', 'KE'],
  ['Yusuf Demir', 'Izmir', 'TR']
];

const TIERS = ['standard', 'standard', 'standard', 'plus', 'plus', 'partner'];
const STATUSES = ['delivered', 'delivered', 'delivered', 'shipped', 'packing', 'cancelled'];

const slug = (name) => name.toLowerCase().replace(/[^a-z]+/g, '-');

/** `2025-03-17` style dates spread over 14 months, without ever reading the clock. */
function orderDate(i) {
  const start = Date.UTC(2025, 4, 6); // 2025-05-06, fixed
  const day = 86400000;
  return new Date(start + i * 7.4 * day).toISOString().slice(0, 10);
}

export function buildDocuments() {
  const rand = prng(20260908);

  const products = PRODUCTS.map(([id, title, category, price, stock]) => ({
    _id: `product:${id}`,
    type: 'product',
    title,
    category,
    price,
    currency: 'EUR',
    stock
  }));

  const customers = PEOPLE.map(([name, city, country], i) => ({
    _id: `customer:${slug(name)}`,
    type: 'customer',
    name,
    city,
    country,
    tier: TIERS[i % TIERS.length],
    since: `20${23 + (i % 3)}-0${1 + (i % 9)}-1${i % 10}`,
    newsletter: i % 3 === 0
  }));

  const orders = [];
  for (let i = 0; i < 60; i += 1) {
    const customer = customers[Math.floor(rand() * customers.length)];
    const lineCount = 1 + Math.floor(rand() * 3);
    const items = [];
    let total = 0;
    for (let l = 0; l < lineCount; l += 1) {
      const p = pick(rand, products);
      const qty = 1 + Math.floor(rand() * 3);
      items.push({ product: p._id, title: p.title, qty, unit_price: p.price });
      total += p.price * qty;
    }
    orders.push({
      _id: `order:2025-${String(1000 + i)}`,
      type: 'order',
      customer: customer._id,
      customer_name: customer.name,
      country: customer.country,
      status: pick(rand, STATUSES),
      placed_at: orderDate(i),
      currency: 'EUR',
      total: Math.round(total * 100) / 100,
      items
    });
  }

  return { products, customers, orders };
}

/**
 * Design documents. These are what `05-design-docs.md` walks through, so they
 * are deliberately ordinary map/reduce — the built-in `_count` and `_sum`
 * reducers rather than anything clever, because the point of the page is to
 * explain what a view *is*.
 */
export const DESIGN_DOCS = {
  [DB.orders]: [
    {
      _id: '_design/reports',
      language: 'javascript',
      views: {
        by_status: {
          map: "function (doc) {\n  if (doc.type === 'order') {\n    emit(doc.status, 1);\n  }\n}",
          reduce: '_count'
        },
        revenue_by_month: {
          map: "function (doc) {\n  if (doc.type === 'order' && doc.status !== 'cancelled') {\n    emit(doc.placed_at.slice(0, 7), doc.total);\n  }\n}",
          reduce: '_sum'
        },
        revenue_by_customer: {
          map: "function (doc) {\n  if (doc.type === 'order' && doc.status !== 'cancelled') {\n    emit(doc.customer_name, doc.total);\n  }\n}",
          reduce: '_sum'
        }
      }
    }
  ],
  [DB.customers]: [
    {
      _id: '_design/directory',
      language: 'javascript',
      views: {
        by_country: {
          map: "function (doc) {\n  if (doc.type === 'customer') {\n    emit(doc.country, doc.name);\n  }\n}",
          reduce: '_count'
        }
      }
    }
  ],
  [DB.products]: [
    {
      _id: '_design/catalogue',
      language: 'javascript',
      views: {
        by_category: {
          map: "function (doc) {\n  if (doc.type === 'product') {\n    emit(doc.category, doc.title);\n  }\n}"
        },
        low_stock: {
          map: "function (doc) {\n  if (doc.type === 'product' && doc.stock < 20) {\n    emit(doc.stock, doc.title);\n  }\n}"
        }
      }
    }
  ]
};

/** Mango indexes — `04-queries.md` shows the planner picking these. */
export const MANGO_INDEXES = {
  [DB.orders]: [
    // `ddoc` is given a name on purpose. Left out, CouchDB invents one from a
    // hash — `_design/4394dda47f0b4c137322adf28c8c087786fe71a1` — which is
    // what the design-document list then shows an administrator for the rest
    // of the database's life. Naming them is both a nicer screenshot and the
    // habit worth teaching.
    { index: { fields: ['status', 'placed_at'] }, ddoc: 'idx-orders', name: 'status-date', type: 'json' },
    { index: { fields: ['country'] }, ddoc: 'idx-orders', name: 'by-country', type: 'json' }
  ],
  [DB.customers]: [
    { index: { fields: ['tier'] }, ddoc: 'idx-customers', name: 'by-tier', type: 'json' }
  ]
};

/**
 * Demo accounts. Passwords are placeholders in a container that is destroyed at
 * the end of the run; nothing here is a credential for anything real.
 */
export const USERS = [
  { name: 'ana.sales', roles: ['sales'], password: 'demo-password' },
  { name: 'bjorn.ops', roles: ['ops', 'sales'], password: 'demo-password' },
  { name: 'chidi.readonly', roles: ['readers'], password: 'demo-password' }
];

/** `_security` on orders — the object `07-users.md` takes apart field by field. */
export const SECURITY = {
  [DB.orders]: {
    admins: { names: [], roles: ['ops'] },
    members: { names: [], roles: ['sales', 'readers'] }
  }
};

export const CATEGORIES_USED = CATEGORIES;

/* ------------------------------------------------------------------ seeding */

const json = { 'content-type': 'application/json' };

/** One request, with the failure message a caller can act on. */
async function req(base, auth, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...json, authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok && res.status !== 412 && res.status !== 409) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/**
 * Fills an empty CouchDB with the scenario above. Idempotent enough to re-run
 * against the same container: 412 (database exists) and 409 (document exists)
 * are treated as success, because a re-run should converge rather than explode.
 */
export async function seed(base, auth, log = () => {}) {
  // The system databases first. A fresh CouchDB 3.x has none of them, and
  // without `_users` there is nowhere to put an account, without `_replicator`
  // nowhere to put a replication — both of which this function then tries to
  // do. Creating them is what `single_node` setup would otherwise do for us.
  for (const db of ['_users', '_replicator', '_global_changes']) {
    await req(base, auth, 'PUT', `/${db}`);
  }

  // Pin the server UUID. CouchDB generates a fresh one per container, the
  // Configuration screen displays it, and a value that changed every run would
  // put one unreviewable pixel diff into the walkthrough on every recapture.
  await req(base, auth, 'PUT', '/_node/_local/_config/couchdb/uuid',
    'c0c0a000feed4b0ca11ab1e5decafbad');
  for (const db of [DB.products, DB.customers, DB.orders, DB.archive]) {
    await req(base, auth, 'PUT', `/${db}`);
  }
  log('databases created');

  const { products, customers, orders } = buildDocuments();
  const bulk = async (db, docs) =>
    req(base, auth, 'POST', `/${db}/_bulk_docs`, { docs });

  await bulk(DB.products, products);
  await bulk(DB.customers, customers);
  await bulk(DB.orders, orders);
  log(`${products.length} products, ${customers.length} customers, ${orders.length} orders`);

  for (const [db, ddocs] of Object.entries(DESIGN_DOCS)) {
    for (const ddoc of ddocs) await req(base, auth, 'POST', `/${db}`, ddoc);
  }
  log('design documents created');

  for (const [db, indexes] of Object.entries(MANGO_INDEXES)) {
    for (const ix of indexes) await req(base, auth, 'POST', `/${db}/_index`, ix);
  }
  log('mango indexes created');

  for (const u of USERS) {
    await req(base, auth, 'PUT', `/_users/org.couchdb.user:${u.name}`, {
      _id: `org.couchdb.user:${u.name}`,
      name: u.name,
      type: 'user',
      roles: u.roles,
      password: u.password
    });
  }
  log(`${USERS.length} users created`);

  for (const [db, sec] of Object.entries(SECURITY)) {
    await req(base, auth, 'PUT', `/${db}/_security`, sec);
  }
  log('_security applied');

  // A continuous replication so the replication screens and the active-task
  // list have something live in them rather than an empty state.
  await req(base, auth, 'POST', '/_replicator', {
    _id: 'orders-to-archive',
    source: `${base}/${DB.orders}`,
    target: `${base}/${DB.archive}`,
    continuous: true,
    owner: 'admin'
  });
  log('replication started');

  // An identity provider, so the IdP screens show a configured provider rather
  // than "No identity providers are registered". The document id IS the issuer
  // (D6). Nothing here contacts a real Keycloak: these are the fields the admin
  // screens read, filled with what a Keycloak realm would have produced.
  // A provider is not a document. Couch Companion reads the list from CouchDB's
  // OWN configuration — one `[oidc] rsa:<kid>` entry per signing key, holding
  // what this deployment decided about the provider, with the matching public
  // key in `[jwt_keys]` where CouchDB's jwt_auth looks for it. Writing a
  // document into an `idp` database would leave the screen empty, which is
  // exactly the wrong lesson for a walkthrough to teach.
  const issuer = 'https://sso.example.internal/realms/couch-companion';
  const kid = 'couch-companion-2026';
  // ASCII only. CouchDB answers `400 Invalid configuration value` for any
  // config value containing a non-ASCII byte, so an em dash in a provider's
  // display name is enough to make the write fail — worth knowing before you
  // name a provider after the team that runs it.
  const entry = {
    name: 'Keycloak (couch-companion realm)',
    issuer,
    client_id: 'couch-companion-ui',
    well_known_url: `${issuer}/.well-known/openid-configuration`,
    roles_claim: 'couchdb_roles',
    idp_only: false,
    alg: 'RS256'
  };
  await req(base, auth, 'PUT', `/_node/_local/_config/oidc/rsa:${kid}`, JSON.stringify(entry));
  await req(base, auth, 'PUT', `/_node/_local/_config/jwt_keys/rsa:${kid}`,
    '-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwalkthr0ughDEM0key\\n-----END PUBLIC KEY-----');
  log('identity provider registered in [oidc]');

  // A real conflict, so the design-document conflict viewer has something to
  // show. Two writers each based a change on the same revision — the everyday
  // way this happens is two servers replicating — and CouchDB kept both rather
  // than picking a winner. `new_edits: false` is how a replication inserts a
  // revision it did not author, which is exactly what is being simulated.
  const live = await req(base, auth, 'GET', `/${DB.orders}/_design/reports`);
  const parent = live._rev.split('-')[1];
  const branch = (id, comment) => ({
    ...live,
    _rev: `2-${id}`,
    _revisions: { start: 2, ids: [id, parent] },
    comment
  });
  await req(base, auth, 'POST', `/${DB.orders}/_bulk_docs`, {
    new_edits: false,
    docs: [
      branch('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'added revenue_by_month on the London node'),
      branch('b2c3d4e5f60718293a4b5c6d7e8f90a1', 'added revenue_by_customer on the Berlin node')
    ]
  });
  log('design-document conflict created');

  // Warm every view, so a screenshot never catches an index still building.
  for (const [db, ddocs] of Object.entries(DESIGN_DOCS)) {
    for (const ddoc of ddocs) {
      for (const view of Object.keys(ddoc.views)) {
        await fetch(`${base}/${db}/${ddoc._id}/_view/${view}?limit=1`, {
          headers: { authorization: auth }
        });
      }
    }
  }
  log('views warmed');
}
