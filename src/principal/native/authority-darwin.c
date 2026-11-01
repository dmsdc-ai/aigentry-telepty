// Task 1215 — Darwin authority-file reader (Node-API v8). First-party, no dependencies.
//
// ONE export: readVerified(path, maximum, privateFile) -> Buffer of verified bytes. It is not a
// generic filesystem primitive: it only ever returns the bytes of a single regular file after the
// same integrity rules as the Linux backend (src/principal/authority-file.js), applied to file
// descriptors pinned component by component with openat(2) and O_NOFOLLOW. Every child is opened
// relative to its already-open parent descriptor, so renaming or replacing a directory after it was
// pinned cannot redirect the traversal; no pathname is ever re-read and no symlink is followed.
//
// Rules (identical to Linux): each directory is a directory owned by root or the caller's uid, with
// no group/other write bit unless it is a root-owned sticky directory (mode & 01777 == 01777). The
// leaf is a regular file owned by root or uid, no group/other write, nlink == 1, 1 <= size <=
// maximum, no group/other bits at all when privateFile; it is read with a bounded loop and must be
// unchanged (dev/ino/size/mtime/ctime, ns) afterwards. Darwin-only and strictly stronger: an extended
// ACL ALLOW entry that grants any write/delete/security/owner permission on a pinned directory or the
// leaf is unsafe, as is any ACL read error other than "no ACL".
//
// Failure: throws Error with code "AUTHORITY_FILE_UNAVAILABLE", a bounded `reason` token and, when a
// syscall failed, an integer `errno`. Every descriptor is closed and the read buffer is zeroed and
// freed on every branch.
//
// Build: scripts/build-authority-darwin.mjs (explicit compiler, SDK and Node-API header inputs).

#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif
#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

// Task 1215 (native-resume5 source experiment): directory handles are pinned with O_EVTONLY — an
// event-only descriptor that requests no directory data access — because they are only used for
// fstat, ACL inspection and as openat() anchors. The leaf is still opened O_RDONLY. There is no
// O_RDONLY or pathname fallback. Whether openat/fstat/acl_get_fd_np accept such a descriptor under a
// given sandbox is a runtime property to be measured, not assumed.
#ifndef O_EVTONLY
#error "O_EVTONLY is required (Darwin <fcntl.h> without _POSIX_C_SOURCE)"
#endif
#define AUTH_DIR_FLAGS (O_EVTONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)

#define AUTH_PATH_MAX 1024
#define AUTH_NAME_MAX 255
#define AUTH_MAXIMUM_LIMIT (16 * 1024 * 1024)

typedef struct {
  const char *reason;
  int err;
} failure_t;

static int fail(failure_t *f, const char *reason, int err) {
  f->reason = reason;
  f->err = err;
  return -1;
}

static void close_fd(int *fd) {
  if (*fd >= 0) {
    int saved = errno;
    close(*fd);
    errno = saved;
    *fd = -1;
  }
}

// 0 = no unsafe ACL entry; -1 = unsafe or unreadable.
static int acl_safe(int fd, failure_t *f) {
  errno = 0;
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) {
    if (errno == ENOENT || errno == ENOTSUP || errno == EOPNOTSUPP) return 0;  // no extended ACL
    return fail(f, "acl_unreadable", errno);
  }
  static const acl_perm_t write_class[] = {
    ACL_WRITE_DATA, ACL_ADD_FILE, ACL_APPEND_DATA, ACL_ADD_SUBDIRECTORY, ACL_DELETE, ACL_DELETE_CHILD,
    ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER,
  };
  int result = 0;
  acl_entry_t entry;
  int which = ACL_FIRST_ENTRY;
  while (acl_get_entry(acl, which, &entry) == 0) {
    which = ACL_NEXT_ENTRY;
    acl_tag_t tag;
    acl_permset_t perms;
    if (acl_get_tag_type(entry, &tag) != 0 || acl_get_permset(entry, &perms) != 0) {
      result = fail(f, "acl_unreadable", errno);
      break;
    }
    if (tag != ACL_EXTENDED_ALLOW) continue;
    for (size_t i = 0; i < sizeof(write_class) / sizeof(write_class[0]); i++) {
      int has = acl_get_perm_np(perms, write_class[i]);
      if (has != 0) {  // 1 = granted, -1 = error: both unsafe
        result = fail(f, has < 0 ? "acl_unreadable" : "acl_grants_write", has < 0 ? errno : 0);
        break;
      }
    }
    if (result != 0) break;
  }
  acl_free(acl);
  return result;
}

static int directory_safe(int fd, uid_t uid, failure_t *f) {
  struct stat st;
  if (fstat(fd, &st) != 0) return fail(f, "component_stat", errno);
  int trusted_sticky_temp = st.st_uid == 0 && (st.st_mode & 01777) == 01777;
  if (!S_ISDIR(st.st_mode) || (st.st_uid != 0 && st.st_uid != uid)
      || ((st.st_mode & 0022) && !trusted_sticky_temp)) return fail(f, "component_unsafe", 0);
  return acl_safe(fd, f);
}

static int same_identity(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size
    && a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec
    && a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

// Validates the shape: absolute, no empty/"."/".." components, no trailing slash, each name <= 255.
static int path_shape_ok(const char *path, size_t len) {
  if (len < 2 || path[0] != '/' || path[len - 1] == '/') return 0;
  size_t start = 1;
  for (size_t i = 1; i <= len; i++) {
    if (i == len || path[i] == '/') {
      size_t n = i - start;
      if (n == 0 || n > AUTH_NAME_MAX) return 0;
      if (n == 1 && path[start] == '.') return 0;
      if (n == 2 && path[start] == '.' && path[start + 1] == '.') return 0;
      start = i + 1;
    }
  }
  return 1;
}

// Returns 0 and sets *out/*out_len (caller frees) on success; -1 with f set otherwise.
static int read_verified(char *path, size_t len, size_t maximum, int private_file,
                         unsigned char **out, size_t *out_len, failure_t *f) {
  int dir = -1, file = -1;
  unsigned char *buffer = NULL;
  size_t capacity = 0;
  int rc = -1;
  uid_t uid = getuid();
  (void)len;
  char *last_slash = strrchr(path, '/');
  if (last_slash == NULL) { fail(f, "path_shape", 0); goto done; }
  int has_directories = last_slash != path;  // "/name" has no directory component below "/"
  *last_slash = '\0';
  char *leaf = last_slash + 1;

  dir = open("/", AUTH_DIR_FLAGS);
  if (dir < 0) { fail(f, "root_open", errno); goto done; }
  // Walk the directory components path[1 .. last_slash-1], now NUL-terminated before the leaf.
  char *cursor = has_directories ? path + 1 : NULL;
  while (cursor != NULL && *cursor != '\0') {
    char *slash = strchr(cursor, '/');
    if (slash != NULL) *slash = '\0';
    int next = openat(dir, cursor, AUTH_DIR_FLAGS);
    if (next < 0) { fail(f, "component_open", errno); goto done; }
    close_fd(&dir);
    dir = next;
    if (directory_safe(dir, uid, f) != 0) goto done;
    if (slash == NULL) break;
    cursor = slash + 1;
  }

  file = openat(dir, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (file < 0) { fail(f, "leaf_open", errno); goto done; }
  struct stat before;
  if (fstat(file, &before) != 0) { fail(f, "leaf_stat", errno); goto done; }
  if (!S_ISREG(before.st_mode) || (before.st_uid != 0 && before.st_uid != uid) || (before.st_mode & 0022)
      || before.st_nlink != 1 || (private_file && (before.st_mode & 0077))) { fail(f, "leaf_unsafe", 0); goto done; }
  if (before.st_size < 1 || (uintmax_t)before.st_size > (uintmax_t)maximum) { fail(f, "size", 0); goto done; }
  if (acl_safe(file, f) != 0) goto done;

  size_t size = (size_t)before.st_size;
  capacity = size + 1;
  buffer = malloc(capacity);
  if (buffer == NULL) { fail(f, "memory", ENOMEM); goto done; }
  size_t total = 0;
  while (total < capacity) {
    ssize_t n = read(file, buffer + total, capacity - total);
    if (n < 0) {
      if (errno == EINTR) continue;
      fail(f, "read", errno);
      goto done;
    }
    if (n == 0) break;
    total += (size_t)n;
  }
  struct stat after;
  if (fstat(file, &after) != 0) { fail(f, "leaf_stat", errno); goto done; }
  if (total != size || !same_identity(&before, &after)) { fail(f, "changed", 0); goto done; }
  *out = buffer;
  *out_len = size;
  buffer = NULL;  // ownership moved to the caller
  rc = 0;

done:
  if (buffer != NULL) {
    memset(buffer, 0, capacity);
    free(buffer);
  }
  close_fd(&file);
  close_fd(&dir);
  return rc;
}

static napi_value throw_unavailable(napi_env env, const char *reason, int err) {
  napi_value code, message, error, reason_value, errno_value;
  if (napi_create_string_utf8(env, "AUTHORITY_FILE_UNAVAILABLE", NAPI_AUTO_LENGTH, &code) != napi_ok
      || napi_create_string_utf8(env, "Authority file is unavailable or unsafe", NAPI_AUTO_LENGTH, &message) != napi_ok
      || napi_create_error(env, code, message, &error) != napi_ok) {
    napi_throw_error(env, "AUTHORITY_FILE_UNAVAILABLE", "Authority file is unavailable or unsafe");
    return NULL;
  }
  if (napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &reason_value) == napi_ok)
    napi_set_named_property(env, error, "reason", reason_value);
  if (err != 0 && napi_create_int32(env, err, &errno_value) == napi_ok)
    napi_set_named_property(env, error, "errno", errno_value);
  napi_throw(env, error);
  return NULL;
}

static napi_value read_verified_js(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3) return throw_unavailable(env, "invalid_argument", 0);
  napi_valuetype t0, t1, t2;
  if (napi_typeof(env, argv[0], &t0) != napi_ok || napi_typeof(env, argv[1], &t1) != napi_ok
      || napi_typeof(env, argv[2], &t2) != napi_ok || t0 != napi_string || t1 != napi_number || t2 != napi_boolean)
    return throw_unavailable(env, "invalid_argument", 0);

  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &len) != napi_ok || len == 0 || len > AUTH_PATH_MAX)
    return throw_unavailable(env, "path_shape", 0);
  char path[AUTH_PATH_MAX + 1];
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &copied) != napi_ok || copied != len
      || strlen(path) != len || !path_shape_ok(path, len))  // strlen != len => embedded NUL
    return throw_unavailable(env, "path_shape", 0);

  double maximum_d = 0;
  if (napi_get_value_double(env, argv[1], &maximum_d) != napi_ok || !(maximum_d >= 1) || maximum_d > AUTH_MAXIMUM_LIMIT
      || maximum_d != (double)(size_t)maximum_d)
    return throw_unavailable(env, "invalid_argument", 0);
  bool private_file = false;
  if (napi_get_value_bool(env, argv[2], &private_file) != napi_ok) return throw_unavailable(env, "invalid_argument", 0);

  unsigned char *bytes = NULL;
  size_t size = 0;
  failure_t f = { "unknown", 0 };
  if (read_verified(path, len, (size_t)maximum_d, private_file ? 1 : 0, &bytes, &size, &f) != 0)
    return throw_unavailable(env, f.reason, f.err);
  napi_value result;
  napi_status status = napi_create_buffer_copy(env, size, bytes, NULL, &result);
  memset(bytes, 0, size + 1);
  free(bytes);
  if (status != napi_ok) return throw_unavailable(env, "memory", 0);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn, abi;
  if (napi_create_function(env, "readVerified", NAPI_AUTO_LENGTH, read_verified_js, NULL, &fn) != napi_ok
      || napi_set_named_property(env, exports, "readVerified", fn) != napi_ok
      || napi_create_int32(env, 1, &abi) != napi_ok
      || napi_set_named_property(env, exports, "abi", abi) != napi_ok) return NULL;
  return exports;
}
