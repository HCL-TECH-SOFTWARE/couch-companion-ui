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

import type { FrontendManifest } from './types/plugin';

/** One bundled plugin: its manifest plus a static import thunk Vite can code-split. */
export interface PluginRegistration {
  manifest: FrontendManifest;
  load: () => Promise<unknown>;
}

/**
 * The complete, build-time plugin registry. Replaces the backend's
 * GET /api/plugins/manifests (spec D7). Route/nav data vendored from
 * couch-companion's pluginManifests.json on 2026-08-05.
 */
export const PLUGIN_REGISTRY: PluginRegistration[] = [
  {
    manifest: {
      "name": "db-mgmt",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/databases/:serverId",
          "component": "cca-db-list",
          "allows_all_servers": true
        },
        {
          "path": "/databases/:serverId/create",
          "component": "cca-db-create"
        },
        {
          "path": "/databases/:serverId/:dbName/documents",
          "component": "cca-doc-browser"
        },
        {
          "path": "/databases/:serverId/:dbName/documents/new",
          "component": "cca-doc-editor"
        },
        {
          "path": "/databases/:serverId/:dbName/documents/:docId",
          "component": "cca-doc-editor"
        },
        {
          "path": "/databases/:serverId/:dbName/query",
          "component": "cca-doc-query"
        },
        {
          "path": "/databases/:serverId/:dbName/indexes",
          "component": "cca-index-manage"
        },
        {
          "path": "/databases/:serverId/:dbName/access",
          "component": "cca-manage-permissions"
        }
      ],
      "nav_items": [
        {
          "label": "Databases",
          "path": "/databases/$all",
          "icon": "database",
          "order": 2
        }
      ],
      "extension_points": []
    },
    load: () => import('./plugins/db-mgmt/index.js')
  },
  {
    manifest: {
      "name": "server-mgmt",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/topology",
          "component": "cca-server-topology"
        },
        {
          "path": "/active-tasks/:serverId",
          "component": "cca-active-tasks",
          "allows_all_servers": true
        }
      ],
      "nav_items": [
        {
          "label": "Topology",
          "path": "/topology",
          "icon": "circle-nodes",
          "order": 1
        }
      ],
      "extension_points": []
    },
    load: () => import('./plugins/server-mgmt/index.js')
  },
  {
    manifest: {
      "name": "design-mgmt",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/design-docs/:serverId",
          "component": "cca-design-list",
          "allows_all_servers": true
        },
        {
          "path": "/design-docs/:serverId/conflicts",
          "component": "cca-conflict-viewer"
        },
        {
          "path": "/design-docs/:serverId/editor/:dbName/:ddocId",
          "component": "cca-view-editor"
        },
        {
          "path": "/version-control",
          "component": "cca-repo-overview"
        }
      ],
      "nav_items": [
        {
          "label": "Design Docs",
          "path": "/design-docs/$all",
          "icon": "pen-nib",
          "order": 8
        },
        {
          "label": "Version Control",
          "path": "/version-control",
          "icon": "code-branch",
          "order": 9
        }
      ],
      "extension_points": []
    },
    load: () => import('./plugins/design-mgmt/index.js')
  },
  {
    manifest: {
      "name": "idp",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/idp",
          "component": "cca-idp-list"
        },
        {
          "path": "/idp/add",
          "component": "cca-idp-add"
        },
        {
          "path": "/idp/logs",
          "component": "cca-idp-logs"
        },
        {
          "path": "/idp/:id",
          "component": "cca-idp-detail"
        }
      ],
      "nav_items": [
        {
          "label": "Identity Providers",
          "path": "/idp",
          "icon": "user-shield",
          "order": 35
        }
      ],
      "extension_points": []
    },
    load: () => import('./plugins/idp/index.js')
  },
  {
    manifest: {
      "name": "users",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/users/:serverId",
          "component": "cca-users-list",
          "allows_all_servers": true
        },
        {
          "path": "/users/:serverId/:userId",
          "component": "cca-user-detail"
        }
      ],
      "nav_items": [
        {
          "label": "Users",
          "path": "/users/$all",
          "icon": "users",
          "order": 36
        }
      ],
      "extension_points": []
    },
    load: () => import('./plugins/users/index.js')
  },
  {
    manifest: {
      "name": "banner-admin",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/banners",
          "component": "cca-banner-admin"
        }
      ],
      "nav_items": [
        {
          "label": "Banners",
          "path": "/banners",
          "icon": "bullhorn",
          "order": 38
        }
      ],
      "extension_points": []
    },
    load: () => import('./plugins/banner-admin/index.js')
  },
  {
    manifest: {
      "name": "replication",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/replications/:serverId",
          "component": "cca-repl-list",
          "allows_all_servers": true
        },
        {
          "path": "/replications/:serverId/create",
          "component": "cca-repl-editor"
        },
        {
          "path": "/replications/:serverId/edit/:replId",
          "component": "cca-repl-editor"
        },
        {
          "path": "/replications/:serverId/view/:replId",
          "component": "cca-repl-editor"
        },
        {
          "path": "/replications/:serverId/preview",
          "component": "cca-repl-preview"
        }
      ],
      "nav_items": [
        {
          "label": "Replication",
          "path": "/replications/$all",
          "icon": "rotate",
          "order": 30
        }
      ],
      "extension_points": []
    },
    load: () => import('./plugins/replication/index.js')
  },
  {
    manifest: {
      "name": "config",
      "version": "0.1.0",
      "routes": [
        {
          "path": "/configuration/:serverId",
          "component": "cca-config",
          "allows_all_servers": true
        },
        {
          "path": "/configuration/compare",
          "component": "cca-config-compare",
          "allows_all_servers": true
        }
      ],
      "nav_items": [],
      "extension_points": []
    },
    load: () => import('./plugins/config/index.js')
  }
];
