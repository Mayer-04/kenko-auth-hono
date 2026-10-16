/**
 * Dominio de identidad/persona (`features/user`).
 *
 * Dueño de la entidad `User` y sus vocabularios cerrados pero ampliables
 * (`GENDERS`, `DOCUMENT_TYPES`: para agregar una opcion basta extender el
 * array; la columna DB es `text` sin enum rigido a proposito).
 * `register` es solo el caso de uso que crea un usuario y reutiliza
 * estos tipos.
 */

export const GENDERS = ['male', 'female', 'other'] as const;
export type Gender = (typeof GENDERS)[number];

export const DOCUMENT_TYPES = ['CC', 'TI', 'CE', 'PA'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type Document = {
  type: DocumentType;
  number: string;
};

export type Person = {
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: Gender;
};

export type Contact = {
  email: string;
  emailVerified: boolean;
  phone: string;
};

export type Address = {
  line: string;
  city: string;
};

export type User = {
  id: string;
  document: Document;
  person: Person;
  contact: Contact;
  address: Address;
};
