import "@girs/gio-2.0";

declare module "@girs/gio-2.0/gio-2.0" {
  export namespace Gio {
    interface File {
      copy_async(destination: File, flags: FileCopyFlags, io_priority: number, cancellable: Cancellable | null, progress_callback_closure: null): globalThis.Promise<boolean>;
    }
  }
}
