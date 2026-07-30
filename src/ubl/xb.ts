import { create } from 'xmlbuilder2';

/**
 * xmlbuilder2 no re-exporta sus interfaces desde el entrypoint, así que el
 * tipo del builder se deriva de la propia factoría.
 */
export type XB = ReturnType<typeof create>;
