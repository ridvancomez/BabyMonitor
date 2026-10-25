namespace BabyMonitor.Services;

/// <summary>
/// Basit deneme sınırı: aynı IP'den art arda 5 yanlış PIN → 1 dakika bekletme.
/// Singleton; bellek içi ve thread-safe.
/// </summary>
public sealed class UnlockAttemptLimiter
{
    public const int MaxFailures = 5;
    public static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(1);

    private readonly object _lock = new();
    private readonly Dictionary<string, Entry> _entries = new();
    private readonly TimeProvider _time;

    public UnlockAttemptLimiter(TimeProvider time)
    {
        _time = time;
    }

    /// <summary>Kilitliyse kalan süre, değilse null.</summary>
    public TimeSpan? GetLockoutRemaining(string key)
    {
        lock (_lock)
        {
            if (!_entries.TryGetValue(key, out var entry) || entry.LockedUntil is not { } until)
                return null;

            var remaining = until - _time.GetUtcNow();
            if (remaining > TimeSpan.Zero)
                return remaining;

            // Bekleme bitti; sayaç sıfırdan başlar.
            _entries.Remove(key);
            return null;
        }
    }

    /// <summary>Yanlış denemeyi kaydeder. Bu deneme kilidi başlattıysa bekleme süresini döner.</summary>
    public TimeSpan? RecordFailure(string key)
    {
        lock (_lock)
        {
            if (!_entries.TryGetValue(key, out var entry))
            {
                entry = new Entry();
                _entries[key] = entry;
            }

            entry.Failures++;
            if (entry.Failures < MaxFailures)
                return null;

            entry.Failures = 0;
            entry.LockedUntil = _time.GetUtcNow() + LockoutDuration;
            return LockoutDuration;
        }
    }

    public void Reset(string key)
    {
        lock (_lock)
        {
            _entries.Remove(key);
        }
    }

    private sealed class Entry
    {
        public int Failures;
        public DateTimeOffset? LockedUntil;
    }
}
