namespace BabyMonitor.Services;

public enum RoomRole
{
    None,
    Broadcaster,
    Viewer
}

public enum JoinResult
{
    Joined,
    AlreadyJoined,
    // Yayıncı için: başka bir yayıncı var. İzleyici için: 2 izleyici dolu.
    Rejected,
    // Bağlantı zaten diğer rolde kayıtlı.
    RoleConflict
}

public sealed record LeaveResult(RoomRole Role, string? BroadcasterId, IReadOnlyList<string> ViewerIds);

/// <summary>
/// Tek odanın bellek içi durumu: bir yayıncı + en fazla 2 izleyici.
/// Singleton olarak kaydedilir; tüm erişimler tek bir kilit altında yapılır.
/// </summary>
public sealed class RoomState
{
    public const int MaxViewers = 2;

    private readonly object _lock = new();
    private readonly List<string> _viewerIds = new();
    private string? _broadcasterId;

    /// <summary>Başarılıysa, yayıncıya bildirilecek bekleyen izleyicileri döner.</summary>
    public JoinResult JoinAsBroadcaster(string connectionId, out IReadOnlyList<string> waitingViewerIds)
    {
        lock (_lock)
        {
            waitingViewerIds = Array.Empty<string>();

            if (_broadcasterId == connectionId)
                return JoinResult.AlreadyJoined;
            if (_viewerIds.Contains(connectionId))
                return JoinResult.RoleConflict;
            if (_broadcasterId is not null)
                return JoinResult.Rejected;

            _broadcasterId = connectionId;
            waitingViewerIds = _viewerIds.ToArray();
            return JoinResult.Joined;
        }
    }

    /// <summary>Başarılıysa, bildirilecek yayıncıyı (varsa) döner.</summary>
    public JoinResult JoinAsViewer(string connectionId, out string? broadcasterId)
    {
        lock (_lock)
        {
            broadcasterId = null;

            if (_viewerIds.Contains(connectionId))
                return JoinResult.AlreadyJoined;
            if (_broadcasterId == connectionId)
                return JoinResult.RoleConflict;
            if (_viewerIds.Count >= MaxViewers)
                return JoinResult.Rejected;

            _viewerIds.Add(connectionId);
            broadcasterId = _broadcasterId;
            return JoinResult.Joined;
        }
    }

    public RoomRole GetRole(string connectionId)
    {
        lock (_lock)
        {
            if (_broadcasterId == connectionId)
                return RoomRole.Broadcaster;
            return _viewerIds.Contains(connectionId) ? RoomRole.Viewer : RoomRole.None;
        }
    }

    public string? GetBroadcasterId()
    {
        lock (_lock)
        {
            return _broadcasterId;
        }
    }

    /// <summary>
    /// Signaling sadece yayıncı ↔ kayıtlı izleyici arasında geçerlidir.
    /// </summary>
    public bool CanSignal(string fromId, string toId)
    {
        lock (_lock)
        {
            if (_broadcasterId is null)
                return false;
            if (fromId == _broadcasterId)
                return _viewerIds.Contains(toId);
            return toId == _broadcasterId && _viewerIds.Contains(fromId);
        }
    }

    /// <summary>
    /// Bağlantıyı odadan çıkarır. Dönen değer, kimlerin bilgilendirileceğini içerir.
    /// Yayıncı çıkınca izleyiciler odada kalır ve yeni yayıncıyı bekler.
    /// </summary>
    public LeaveResult Leave(string connectionId)
    {
        lock (_lock)
        {
            if (_broadcasterId == connectionId)
            {
                _broadcasterId = null;
                return new LeaveResult(RoomRole.Broadcaster, null, _viewerIds.ToArray());
            }

            if (_viewerIds.Remove(connectionId))
                return new LeaveResult(RoomRole.Viewer, _broadcasterId, Array.Empty<string>());

            return new LeaveResult(RoomRole.None, null, Array.Empty<string>());
        }
    }
}
