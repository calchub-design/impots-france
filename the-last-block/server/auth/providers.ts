/**
 * Points d'extension pour une future connexion Google / Apple.
 *
 * AUCUNE vérification n'est simulée ici : tant qu'une implémentation réelle
 * n'existe pas, `verifyIdToken` lève systématiquement `AuthNotAvailableError`
 * et le serveur refuse la connexion par ce fournisseur. On évite ainsi toute
 * fausse sécurité (ex. accepter un jeton sans vérifier sa signature).
 *
 * Une implémentation réelle devra au minimum :
 *  - récupérer et mettre en cache les clés publiques JWKS du fournisseur
 *    (Google : https://www.googleapis.com/oauth2/v3/certs,
 *     Apple : https://appleid.apple.com/auth/keys) ;
 *  - vérifier la signature (RS256/ES256), `iss`, `aud` (= client id), `exp`,
 *    `iat` et un `nonce` lié à la session pour empêcher le rejeu ;
 *  - lier le `sub` stable du fournisseur au compte joueur (table dédiée),
 *    avec un parcours explicite de rattachement d'un compte invité existant.
 */

export interface VerifiedIdentity {
  provider: 'google' | 'apple';
  /** Identifiant stable du compte chez le fournisseur (`sub`). */
  subject: string;
  email?: string;
  emailVerified?: boolean;
}

export interface IdentityProvider {
  readonly name: 'google' | 'apple';
  /** Vrai seulement si une implémentation réelle ET un client id sont présents. */
  isAvailable(): boolean;
  verifyIdToken(idToken: string, expectedNonce: string): Promise<VerifiedIdentity>;
}

export class AuthNotAvailableError extends Error {
  constructor(provider: string) {
    super(`La connexion via ${provider} n'est pas disponible dans ce prototype.`);
  }
}

class UnimplementedProvider implements IdentityProvider {
  constructor(
    readonly name: 'google' | 'apple',
    private readonly clientId: string,
  ) {}

  isAvailable(): boolean {
    // Même si un client id est fourni, la vérification n'est pas implémentée :
    // on ne prétend jamais être disponible.
    void this.clientId;
    return false;
  }

  async verifyIdToken(): Promise<VerifiedIdentity> {
    throw new AuthNotAvailableError(this.name);
  }
}

export function createIdentityProviders(cfg: { googleClientId: string; appleClientId: string }): Record<'google' | 'apple', IdentityProvider> {
  return {
    google: new UnimplementedProvider('google', cfg.googleClientId),
    apple: new UnimplementedProvider('apple', cfg.appleClientId),
  };
}
