import { arrayPrototype } from "./ArrayPrototypes.js";
import { stringPrototype } from "./StringPrototypes.js";
import { coroutinePrototype } from "./CoroutinePrototypes.js";

export const LibraryScheme = "tcd";
export const ArrayPrototypeBuiltin = `${LibraryScheme}:/ArrayPrototypes.tc`;
export const CoroutinePrototypeBuiltin = `${LibraryScheme}:/CoroutinePrototypes.tc`;
export const StringPrototypeBuiltin = `${LibraryScheme}:/StringPrototypes.tc`;

export const builtins = {
    [ArrayPrototypeBuiltin]: `${arrayPrototype}`,
    [CoroutinePrototypeBuiltin]: `${coroutinePrototype}`,
    [StringPrototypeBuiltin]: `${stringPrototype}`,
}