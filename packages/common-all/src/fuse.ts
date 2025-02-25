import Fuse from "fuse.js";
import _ from "lodash";
import {
  DEngineMode,
  SchemaProps,
  NoteProps,
  SchemaModuleDict,
  SchemaUtils,
  NotePropsDict,
  SchemaModuleProps,
  NoteUtils,
  DNodeUtils,
  DEngineClient,
} from ".";
import { DendronConfig, DVault } from "./types/workspace";

export type NoteIndexProps = {
  id: string;
  title: string;
  fname: string;
  vault: DVault;
};

function createFuse<T>(
  initList: T[],
  opts: Fuse.IFuseOptions<any> & {
    exactMatch: boolean;
    preset: "schema" | "note";
  }
) {
  const options: Fuse.IFuseOptions<any> = {
    shouldSort: true,
    threshold: opts.exactMatch ? 0.0 : 0.5,
    location: 0,
    distance: 15,
    minMatchCharLength: 2,
    keys: ["fname"],
    useExtendedSearch: true,
    includeScore: true,
    ignoreLocation: true,
    ignoreFieldNorm: true,
  };
  if (opts.preset === "schema") {
    options.keys = ["fname", "id"];
  }
  const fuse = new Fuse(initList, options);
  return fuse;
}

type FuseEngineOpts = {
  mode?: DEngineMode;
};

export class FuseEngine {
  public notesIndex: Fuse<NoteIndexProps>;
  public schemaIndex: Fuse<SchemaProps>;

  constructor(opts: FuseEngineOpts) {
    this.notesIndex = createFuse<NoteProps>([], {
      exactMatch: opts.mode === "exact",
      preset: "note",
    });
    this.schemaIndex = createFuse<SchemaProps>([], {
      exactMatch: opts.mode === "exact",
      preset: "schema",
    });
  }

  async querySchema({ qs }: { qs: string }): Promise<SchemaProps[]> {
    let items: SchemaProps[];
    if (qs === "") {
      const results = this.schemaIndex.search("root");
      items = [results[0].item];
    } else if (qs === "*") {
      // @ts-ignore
      items = this.schemaIndex._docs;
    } else {
      const results = this.schemaIndex.search(qs);
      items = _.map(results, (resp) => resp.item);
    }
    return items;
  }

  /**
   * If qs = "", return root note
   * @param param0
   * @returns
   */
  queryNote({ qs }: { qs: string }): NoteIndexProps[] {
    let items: NoteIndexProps[];
    if (qs === "") {
      const results = this.notesIndex.search("root");
      items = _.map(
        _.filter(results, (ent) => ent.item.fname === "root"),
        (ent) => ent.item
      );
    } else if (qs === "*") {
      // @ts-ignore
      items = this.notesIndex._docs as NoteProps[];
    } else {
      const results = this.notesIndex.search(qs);
      items = _.map(results, (resp) => resp.item);
    }
    return items;
  }

  async updateSchemaIndex(schemas: SchemaModuleDict) {
    this.schemaIndex.setCollection(
      _.map(_.values(schemas), (ent) => SchemaUtils.getModuleRoot(ent))
    );
  }

  async updateNotesIndex(notes: NotePropsDict) {
    this.notesIndex.setCollection(
      _.map(notes, ({ fname, title, id, vault }, _key) => ({
        fname,
        id,
        title,
        vault,
      }))
    );
  }

  async removeNoteFromIndex(note: NoteProps) {
    this.notesIndex.remove((doc) => {
      // FIXME: can be undefined, dunno why
      if (!doc) {
        return false;
      }
      return doc.id === note.id;
    });
  }

  async removeSchemaFromIndex(smod: SchemaModuleProps) {
    this.schemaIndex.remove((doc: SchemaProps) => {
      // FIXME: can be undefined, dunno why
      if (!doc) {
        return false;
      }
      return doc.id === SchemaUtils.getModuleRoot(smod).id;
    });
  }
}

const PAGINATE_LIMIT = 50;
export class NoteLookupUtils {
  /**
   * Get qs for current level of the hierarchy
   * @param qs
   * @returns
   */
  static getQsForCurrentLevel = (qs: string) => {
    const lastDotIndex = qs.lastIndexOf(".");
    return lastDotIndex < 0 ? "" : qs.slice(0, lastDotIndex + 1);
  };

  static fetchRootResults = (
    notes: NotePropsDict,
    opts?: Partial<{ config: DendronConfig }>
  ) => {
    const roots: NoteProps[] =
      opts?.config?.site.siteHierarchies === ["root"]
        ? NoteUtils.getRoots(notes)
        : opts!.config!.site.siteHierarchies.flatMap((fname) =>
            NoteUtils.getNotesByFname({ fname, notes })
          );
    const childrenOfRoot = roots.flatMap((ent) => ent.children);
    const nodes = _.map(childrenOfRoot, (ent) => notes[ent]).concat(roots);
    return nodes;
  };

  static async lookup({
    qs,
    engine,
    showDirectChildrenOnly,
  }: {
    qs: string;
    engine: DEngineClient;
    showDirectChildrenOnly?: boolean;
  }): Promise<NoteProps[]> {
    const { notes } = engine;
    const qsClean = this.slashToDot(qs);
    if (_.isEmpty(qsClean)) {
      return NoteLookupUtils.fetchRootResults(notes);
    }
    const resp = await engine.queryNotes({ qs });
    let nodes: NoteProps[];
    if (showDirectChildrenOnly) {
      const depth = qs.split(".").length;
      nodes = resp.data
        .filter((ent) => {
          return DNodeUtils.getDepth(ent) === depth;
        })
        .filter((ent) => !ent.stub);
    } else {
      nodes = resp.data;
    }
    if (nodes.length > PAGINATE_LIMIT) {
      nodes = nodes.slice(0, PAGINATE_LIMIT);
    }
    return nodes;
  }

  static slashToDot(ent: string) {
    return ent.replace(/\//g, ".");
  }
}
