/**
 * Base Source Provider Class
 */

import type { SourceStream } from '../models/source-model.js';

export interface SourceFetchOptions {
  debridProvider?: 'realdebrid' | 'torbox';
  realdebridToken?: string;
  torboxToken?: string;
  forceFresh?: boolean;
}

export abstract class BaseSourceProvider {
  /**
   * Fonte principal: quando ela responde com streams, a SourceService espera as
   * outras só por uma janela curta (SOURCE_GRACE_MS).
   */
  readonly primary: boolean = false;

  constructor(public name: string) {}

  abstract getStreams(
    type: string,
    id: string,
    options?: SourceFetchOptions
  ): Promise<SourceStream[]>;
}
