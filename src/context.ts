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

import { ApiClient } from './services/api-client';
import { AuthService } from './services/auth-service';
import { PluginLoader } from './services/plugin-loader';
import { Router } from './router';
import { ServerMgmtService } from './services/server-mgmt-service';
import { IdpService } from './services/idp-service';
import { DesignMgmtService } from './services/design-mgmt-service';
import { DbMgmtService } from './services/db-mgmt-service.js';
import { AttachmentService } from './services/attachments.js';
import { CouchCompanionStore } from './services/git/couchcompanion-store.js';
import { GitCredentialStore, type CouchTokenIo } from './services/git/git-credential-store.js';
import { UsersService } from './services/users-service.js';
import { BannerAdminService } from './services/banner-admin-service.js';
import { ServerDashboardService } from './services/server-dashboard-service';
import { getRouter } from './customEventRouter.js';
import { ConfigService } from './services/config-service.js';
import { MembershipService } from './services/membership-service.js';
import { CspService } from './services/csp-service.js';
import { ReplicationService } from './services/replication-service.js';
import { ReachabilityStatusService } from './services/reachability-status-service.js';
import type { Deployment } from './services/deployment-mode';
import { SINGLE_SERVER_ID } from './services/single-server.js';

/** Shared singleton wiring all services together — the only import most components need. */
export interface AppContext {
  api: ApiClient;
  auth: AuthService;
  router: Router;
  plugins: PluginLoader;
  serverMgmt: ServerMgmtService;
  reachabilityStatus: ReachabilityStatusService;
  idp: IdpService;
  designMgmt: DesignMgmtService;
  replication: ReplicationService;
  dbMgmt: DbMgmtService;
  /** Upload, download and delete of document attachments (#120). */
  attachments: AttachmentService;
  users: UsersService;
  bannerAdmin: BannerAdminService;
  serverDashboard: ServerDashboardService;
  config: ConfigService;
  /** Enumerates the cluster's nodes, so configuration can be compared across them (#73). */
  membership: MembershipService;
  /** Reads the live `/_utils` Content-Security-Policy and writes its replacement (#34). */
  csp: CspService;
  deployment: Deployment;
  /**
   * The server every screen operates on. This deployment manages exactly one
   * CouchDB (spec D2/D3), so it is the {@link SINGLE_SERVER_ID} constant, not
   * mutable state — there is no picker left to change it (#31). Kept as a
   * readable member (spec D6) so consumers need no rewrite.
   */
  readonly selectedServer: string;
  setDeployment(d: Deployment): void;
}

let _context: AppContext | null = null;

/**
 * The `CouchTokenIo` port `GitCredentialStore` needs for its `couchdb` mode — reads and writes
 * `auth.token` on the git account document it is given an id for. Private to this wiring:
 * `DesignMgmtService` writes `auth.token` directly when it first creates an account in `couchdb`
 * mode (so the token never has to round-trip through here on create), and this adapter only has
 * to serve the later reads/writes `GitCredentialStore.get`/`put`/`forget` make against an
 * already-existing document.
 */
function couchTokenIo(store: CouchCompanionStore): CouchTokenIo {
  return {
    async readToken(accountId: string) {
      const account = await store.get<{ auth?: { token?: string } }>(accountId);
      return account?.auth?.token ?? null;
    },
    async writeToken(accountId: string, token: string | null) {
      const account = await store.get<Record<string, unknown>>(accountId);
      // Nothing to update — the account is gone or was never created under this id.
      if (!account) return;
      const { auth: _auth, ...rest } = account;
      await store.put(accountId, token === null ? rest : { ...rest, auth: { token } });
    }
  };
}

const initContext = (): AppContext => {
  if (_context) {
    return _context;
  }

  // Create ApiClient with 401 callback that will be wired to auth.logout()
  const api = new ApiClient('', () => {
    // This callback is invoked on 401 errors to trigger logout
    if (_context) {
      _context.auth.logout();
    }
  });
  const auth = new AuthService(api, () => _context?.deployment ?? { mode: "spa", baseUrl: "" });
  const router = new Router();
  const plugins = new PluginLoader(router);
  const serverMgmt = new ServerMgmtService(api);
  const reachabilityStatus = new ReachabilityStatusService(api);
  const couchCompanionStore = new CouchCompanionStore(api);
  const config = new ConfigService(api);
  const membership = new MembershipService(api);
  const csp = new CspService(api, config);
  const idp = new IdpService(api, couchCompanionStore, config);
  const gitCredentials = new GitCredentialStore(couchTokenIo(couchCompanionStore));
  const designMgmt = new DesignMgmtService(api, couchCompanionStore, gitCredentials);
  const replication = new ReplicationService(api);
  const dbMgmt = new DbMgmtService(api);
  const attachments = new AttachmentService(api);
  const users = new UsersService(dbMgmt);
  const bannerAdmin = new BannerAdminService(dbMgmt);
  const serverDashboard = new ServerDashboardService(serverMgmt, idp, replication, getRouter());
  serverDashboard.start();

  _context = {
    api,
    auth,
    router,
    plugins,
    serverMgmt,
    reachabilityStatus,
    idp,
    designMgmt,
    replication,
    dbMgmt,
    attachments,
    users,
    bannerAdmin,
    serverDashboard,
    config,
    membership,
    csp,
    deployment: { mode: "spa", baseUrl: "" },
    // Defined as a getter, not a data property: there is one server and no way
    // to pick another, so an accidental write must not take hold.
    get selectedServer() {
      return SINGLE_SERVER_ID;
    },
    setDeployment(d: Deployment) {
      _context!.deployment = d;
      _context!.api.setBaseUrl(d.baseUrl);
    }
  };
  return _context;
};

/**
 * Returns the singleton AppContext, creating it on first call. Prefer this over manual service construction.
 * @returns the shared AppContext instance
 */
export function getContext(): AppContext {
  return _context ?? initContext();
}
