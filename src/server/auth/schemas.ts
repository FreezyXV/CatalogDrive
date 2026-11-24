import { z } from "zod";
import { ROLES } from "./rbac";

export const emailSchema = z
  .email("Indiquez une adresse email valide.")
  .max(254)
  .transform((email) => email.toLowerCase());
export const passwordSchema = z
  .string()
  .min(12, "Le mot de passe doit contenir au moins 12 caractères.")
  .max(128, "Le mot de passe est limité à 128 caractères.");
export const tokenSchema = z
  .string()
  .min(20, "Lien invalide.")
  .max(128, "Lien invalide.");
export const roleSchema = z.enum(ROLES, "Rôle inconnu.");
