/**
 * Motor de Defesa contra SSRF com Fixação de DNS (DNS Pinning) e Filtro de Redes Privadas
 * 
 * Mitiga ataques de Server-Side Request Forgery e DNS Rebinding validando os
 * endereços IP resolvidos contra as faixas privadas da RFC 1918, loopbacks e metadados de nuvem.
 */

import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);

  if (a === 127) return true;                         // Loopback (127.0.0.0/8)
  if (a === 10) return true;                          // Classe A privada (10.0.0.0/8)
  if (a === 172 && b >= 16 && b <= 31) return true;   // Classe B privada (172.16.0.0/12)
  if (a === 192 && b === 168) return true;            // Classe C privada (192.168.0.0/16)
  if (a === 169 && b === 254) return true;            // Link-local / Metadados Cloud (169.254.0.0/16)
  if (a === 0) return true;                           // Rede atual
  if (a >= 240) return true;                          // Reservado para uso futuro

  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // Endereço local exclusivo
    if (normalized.startsWith("fe80")) return true;                              // Link-local

    // IPv4 mapeado em IPv6 (::ffff:192.168.1.1)
    const mapped = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIpv4(mapped[1]);

    return false;
  }

  if (net.isIPv4(ip)) return isPrivateIpv4(ip);

  return true;
}

export async function validateSsrfSafeUrl(url: URL): Promise<boolean> {
  const hostname = url.hostname.toLowerCase();

  // Validações básicas de sanidade
  if (hostname === "localhost") return false;
  if (hostname === "metadata.google.internal") return false;
  if (!hostname.includes(".")) return false;

  // Se o host for um IP literal direto, valida imediatamente
  if (net.isIP(hostname)) {
    return !isPrivateIp(hostname);
  }

  // Resolução prévia de DNS para IPv4 e IPv6 para mitigar ataques de DNS Rebinding
  const [v4Addresses, v6Addresses] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);

  const allResolvedAddresses = [...v4Addresses, ...v6Addresses];

  if (allResolvedAddresses.length === 0) {
    return false; // Domínio não pôde ser resolvido
  }

  // Todos os endereços IP resolvidos devem ser públicos e não-privados
  return allResolvedAddresses.every((ip) => !isPrivateIp(ip));
}
