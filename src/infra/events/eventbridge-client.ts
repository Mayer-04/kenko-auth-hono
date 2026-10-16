import { EventBridgeClient } from '@aws-sdk/client-eventbridge';

import { DEFAULT_EVENT_BUS_NAME } from './event.constants.js';

/**
 * Cliente EventBridge. Las credenciales NO viven en el env: el SDK usa la
 * cadena estandar (AWS CLI / perfil / rol IAM). Solo region y bus por env.
 */
export const createEventBridgeClient = (
  region: string | undefined,
): EventBridgeClient => {
  return new EventBridgeClient(region !== undefined ? { region } : {});
};

export const resolveBusName = (configured: string | undefined): string => {
  return configured ?? DEFAULT_EVENT_BUS_NAME;
};
